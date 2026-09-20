use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::errors::VaultError;
use crate::events::{Deposited, Tranche};
use crate::math;
use crate::state::*;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SERIES_SEED, &series.id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, address = series.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = user_underlying.owner == user.key()
        && user_underlying.mint == series.underlying_mint @ VaultError::InvalidParams)]
    pub user_underlying: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_shares.owner == user.key()
        && user_shares.mint == share_mint.key() @ VaultError::InvalidParams)]
    pub user_shares: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

fn deposit_inner(ctx: Context<Deposit>, amount: u64, tranche: Tranche) -> Result<()> {
    require!(amount > 0, VaultError::InvalidParams);
    require!(!ctx.accounts.config.paused, VaultError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let s = &ctx.accounts.series;
    require!(s.status == Status::Open, VaultError::WrongStatus);
    require!(now < s.deposit_deadline, VaultError::DepositWindowClosed);

    let expected_mint = match tranche {
        Tranche::Senior => s.senior_mint,
        Tranche::Junior => s.junior_mint,
    };
    require_keys_eq!(ctx.accounts.share_mint.key(), expected_mint, VaultError::InvalidParams);

    let (new_senior, new_junior) = match tranche {
        Tranche::Senior => (s.senior_principal.checked_add(amount).ok_or(VaultError::MathOverflow)?, s.junior_principal),
        Tranche::Junior => (s.senior_principal, s.junior_principal.checked_add(amount).ok_or(VaultError::MathOverflow)?),
    };
    // Capacity rule, enforced on every senior deposit (junior deposits only improve the ratio).
    if tranche == Tranche::Senior {
        require!(math::junior_ratio_ok(new_senior, new_junior, s.min_junior_bps), VaultError::JuniorBufferTooSmall);
    }

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_underlying.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    let id_bytes = s.id.to_le_bytes();
    let bump = [s.bump];
    let seeds: &[&[u8]] = &[SERIES_SEED, &id_bytes, &bump];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.user_shares.to_account_info(),
                authority: ctx.accounts.series.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    let series_key = ctx.accounts.series.key();
    let s = &mut ctx.accounts.series;
    s.senior_principal = new_senior;
    s.junior_principal = new_junior;
    emit!(Deposited { series: series_key, user: ctx.accounts.user.key(), tranche, amount });
    Ok(())
}

pub fn deposit_senior_handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    deposit_inner(ctx, amount, Tranche::Senior)
}

pub fn deposit_junior_handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    deposit_inner(ctx, amount, Tranche::Junior)
}
