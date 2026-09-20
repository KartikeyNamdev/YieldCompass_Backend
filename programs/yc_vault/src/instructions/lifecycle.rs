use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::VaultError;
use crate::events::{Activated, Cancelled, Refunded, Settled};
use crate::math;
use crate::state::*;

// ---------------------------------------------------------------- activate

#[derive(Accounts)]
pub struct Activate<'info> {
    /// Anyone may call after the deposit deadline.
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SERIES_SEED, &series.id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(address = series.risk_entry)]
    pub risk_entry: Box<Account<'info, RiskEntry>>,
    #[account(mut, address = series.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(address = series.strategy_pool)]
    pub strategy_pool: Box<Account<'info, mock_yield::Pool>>,
    #[account(mut, address = strategy_pool.vault)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,
    pub mock_yield_program: Program<'info, mock_yield::program::MockYield>,
    pub token_program: Program<'info, Token>,
}

pub fn activate_handler(ctx: Context<Activate>) -> Result<()> {
    require!(!ctx.accounts.config.paused, VaultError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let s = &ctx.accounts.series;
    require!(s.status == Status::Open, VaultError::WrongStatus);
    require!(now >= s.deposit_deadline, VaultError::DepositWindowOpen);
    s.check_activation(&ctx.accounts.risk_entry, now)?;

    let amount = ctx.accounts.vault.amount;
    let id_bytes = s.id.to_le_bytes();
    let bump = [s.bump];
    let seeds: &[&[u8]] = &[SERIES_SEED, &id_bytes, &bump];
    let term = s.term_secs;

    mock_yield::cpi::deposit(
        CpiContext::new_with_signer(
            ctx.accounts.mock_yield_program.to_account_info(),
            mock_yield::cpi::accounts::PoolDeposit {
                depositor: ctx.accounts.series.to_account_info(),
                pool: ctx.accounts.strategy_pool.to_account_info(),
                from: ctx.accounts.vault.to_account_info(),
                pool_vault: ctx.accounts.pool_vault.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    let series_key = ctx.accounts.series.key();
    let s = &mut ctx.accounts.series;
    s.start_ts = now;
    s.maturity_ts = now.checked_add(term).ok_or(VaultError::MathOverflow)?;
    s.status = Status::Active;
    emit!(Activated { series: series_key, start_ts: s.start_ts, maturity_ts: s.maturity_ts, deployed: amount });
    Ok(())
}

// ---------------------------------------------------------------- cancel

#[derive(Accounts)]
pub struct CancelSeries<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SERIES_SEED, &series.id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(address = series.risk_entry)]
    pub risk_entry: Box<Account<'info, RiskEntry>>,
}

pub fn cancel_series_handler(ctx: Context<CancelSeries>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let s = &ctx.accounts.series;
    require!(s.status == Status::Open, VaultError::WrongStatus);
    require!(now >= s.deposit_deadline, VaultError::DepositWindowOpen);
    // Cancellable only if activation is impossible (or the program is paused, so funds are never stuck).
    let blocked = ctx.accounts.config.paused || s.check_activation(&ctx.accounts.risk_entry, now).is_err();
    require!(blocked, VaultError::ActivationConditionsMet);
    let series_key = ctx.accounts.series.key();
    ctx.accounts.series.status = Status::Cancelled;
    emit!(Cancelled { series: series_key });
    Ok(())
}

// ---------------------------------------------------------------- refund

#[derive(Accounts)]
pub struct Refund<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [SERIES_SEED, &series.id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, address = series.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = series.senior_mint)]
    pub senior_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = series.junior_mint)]
    pub junior_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = user_senior.owner == user.key() && user_senior.mint == senior_mint.key() @ VaultError::InvalidParams)]
    pub user_senior: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_junior.owner == user.key() && user_junior.mint == junior_mint.key() @ VaultError::InvalidParams)]
    pub user_junior: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_underlying.owner == user.key()
        && user_underlying.mint == series.underlying_mint @ VaultError::InvalidParams)]
    pub user_underlying: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Cancelled series only: burn all of the user's shares and return principal 1:1.
/// Deliberately does not read `Config`, so pausing can never block a refund.
pub fn refund_handler(ctx: Context<Refund>) -> Result<()> {
    require!(ctx.accounts.series.status == Status::Cancelled, VaultError::WrongStatus);
    let senior = ctx.accounts.user_senior.amount;
    let junior = ctx.accounts.user_junior.amount;
    let amount = senior.checked_add(junior).ok_or(VaultError::MathOverflow)?;
    require!(amount > 0, VaultError::NothingToClaim);

    if senior > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.senior_mint.to_account_info(),
                    from: ctx.accounts.user_senior.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            senior,
        )?;
    }
    if junior > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.junior_mint.to_account_info(),
                    from: ctx.accounts.user_junior.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            junior,
        )?;
    }

    let s = &ctx.accounts.series;
    let id_bytes = s.id.to_le_bytes();
    let bump = [s.bump];
    let seeds: &[&[u8]] = &[SERIES_SEED, &id_bytes, &bump];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_underlying.to_account_info(),
                authority: ctx.accounts.series.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    emit!(Refunded { series: ctx.accounts.series.key(), user: ctx.accounts.user.key(), amount });
    Ok(())
}

// ---------------------------------------------------------------- settle

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Anyone (the keeper) may call after maturity.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [SERIES_SEED, &series.id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, address = series.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(address = series.strategy_pool)]
    pub strategy_pool: Box<Account<'info, mock_yield::Pool>>,
    #[account(mut, address = strategy_pool.vault)]
    pub pool_vault: Box<Account<'info, TokenAccount>>,
    pub mock_yield_program: Program<'info, mock_yield::program::MockYield>,
    pub token_program: Program<'info, Token>,
}

pub fn settle_handler(ctx: Context<Settle>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let s = &ctx.accounts.series;
    require!(s.status == Status::Active, VaultError::WrongStatus);
    require!(now >= s.maturity_ts, VaultError::NotMatured);

    let id_bytes = s.id.to_le_bytes();
    let bump = [s.bump];
    let seeds: &[&[u8]] = &[SERIES_SEED, &id_bytes, &bump];
    let (senior_principal, rate_bps, term_secs) = (s.senior_principal, s.rate_bps, s.term_secs);

    mock_yield::cpi::withdraw_all(CpiContext::new_with_signer(
        ctx.accounts.mock_yield_program.to_account_info(),
        mock_yield::cpi::accounts::PoolWithdraw {
            depositor: ctx.accounts.series.to_account_info(),
            pool: ctx.accounts.strategy_pool.to_account_info(),
            pool_vault: ctx.accounts.pool_vault.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
        &[seeds],
    ))?;
    ctx.accounts.vault.reload()?;
    let total_assets = ctx.accounts.vault.amount;

    let owed = math::senior_owed(senior_principal, rate_bps, term_secs).ok_or(VaultError::MathOverflow)?;
    let (senior_payout, junior_payout) = math::waterfall(total_assets, owed);

    let series_key = ctx.accounts.series.key();
    let s = &mut ctx.accounts.series;
    s.senior_payout = senior_payout;
    s.junior_payout = junior_payout;
    s.status = Status::Settled;
    emit!(Settled { series: series_key, total_assets, senior_payout, junior_payout });
    Ok(())
}
