//! mock_yield: DEVNET TEST DOUBLE.
//!
//! This is NOT a real yield strategy. It exists so the demo can show +6% / 0% / -10% outcomes
//! in minutes via `simulate_yield` and `simulate_loss`. Never deploy to mainnet.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("13uN3ZYV2puWDXKCLYgxA5ZSYYnBky4cGnuvQDdmpW4B");

pub const BPS: u128 = 10_000;

#[program]
pub mod mock_yield {
    use super::*;

    /// Create a pool bound to one `depositor` (the vault's Series PDA).
    pub fn init_pool(ctx: Context<InitPool>, depositor: Pubkey) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.admin = ctx.accounts.admin.key();
        pool.depositor = depositor;
        pool.mint = ctx.accounts.mint.key();
        pool.vault = ctx.accounts.pool_vault.key();
        pool.reserve = ctx.accounts.reserve.key();
        pool.sink = ctx.accounts.sink.key();
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    pub fn deposit(ctx: Context<PoolDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, MockError::InvalidAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.pool_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )
    }

    pub fn withdraw_all(ctx: Context<PoolWithdraw>) -> Result<()> {
        let amount = ctx.accounts.pool_vault.amount;
        let depositor = ctx.accounts.pool.depositor;
        let bump = [ctx.accounts.pool.bump];
        let seeds: &[&[u8]] = &[b"pool", depositor.as_ref(), &bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_vault.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    /// Move `bps` of the pool balance from the faucet reserve into the pool.
    pub fn simulate_yield(ctx: Context<Simulate>, bps: u16) -> Result<()> {
        let amount = bps_of(ctx.accounts.pool_vault.amount, bps)?;
        require!(ctx.accounts.reserve.amount >= amount, MockError::InsufficientReserve);
        move_tokens(&ctx.accounts, ctx.accounts.reserve.to_account_info(), ctx.accounts.pool_vault.to_account_info(), amount)
    }

    /// Move `bps` of the pool balance out to the sink account.
    pub fn simulate_loss(ctx: Context<Simulate>, bps: u16) -> Result<()> {
        let amount = bps_of(ctx.accounts.pool_vault.amount, bps)?;
        move_tokens(&ctx.accounts, ctx.accounts.pool_vault.to_account_info(), ctx.accounts.sink.to_account_info(), amount)
    }
}

fn bps_of(amount: u64, bps: u16) -> Result<u64> {
    require!(bps as u128 <= BPS, MockError::InvalidAmount);
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .and_then(|v| v.checked_div(BPS))
        .ok_or(MockError::MathOverflow)?;
    u64::try_from(v).map_err(|_| error!(MockError::MathOverflow))
}

fn move_tokens<'info>(
    a: &Simulate<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let depositor = a.pool.depositor;
    let bump = [a.pool.bump];
    let seeds: &[&[u8]] = &[b"pool", depositor.as_ref(), &bump];
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            Transfer { from, to, authority: a.pool.to_account_info() },
            &[seeds],
        ),
        amount,
    )
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub depositor: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub reserve: Pubkey,
    pub sink: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(depositor: Pubkey)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = admin, space = 8 + Pool::INIT_SPACE, seeds = [b"pool", depositor.as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    #[account(init, payer = admin, seeds = [b"pool_vault", pool.key().as_ref()], bump,
        token::mint = mint, token::authority = pool)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(init, payer = admin, seeds = [b"reserve", pool.key().as_ref()], bump,
        token::mint = mint, token::authority = pool)]
    pub reserve: Account<'info, TokenAccount>,
    #[account(init, payer = admin, seeds = [b"sink", pool.key().as_ref()], bump,
        token::mint = mint, token::authority = pool)]
    pub sink: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolDeposit<'info> {
    pub depositor: Signer<'info>,
    #[account(constraint = pool.depositor == depositor.key() @ MockError::Unauthorized)]
    pub pool: Account<'info, Pool>,
    #[account(mut, constraint = from.owner == depositor.key() && from.mint == pool.mint @ MockError::Unauthorized)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut, address = pool.vault)]
    pub pool_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PoolWithdraw<'info> {
    pub depositor: Signer<'info>,
    #[account(constraint = pool.depositor == depositor.key() @ MockError::Unauthorized)]
    pub pool: Account<'info, Pool>,
    #[account(mut, address = pool.vault)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = to.owner == depositor.key() && to.mint == pool.mint @ MockError::Unauthorized)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Simulate<'info> {
    pub admin: Signer<'info>,
    #[account(has_one = admin @ MockError::Unauthorized)]
    pub pool: Account<'info, Pool>,
    #[account(mut, address = pool.vault)]
    pub pool_vault: Account<'info, TokenAccount>,
    #[account(mut, address = pool.reserve)]
    pub reserve: Account<'info, TokenAccount>,
    #[account(mut, address = pool.sink)]
    pub sink: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum MockError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Faucet reserve too small")]
    InsufficientReserve,
    #[msg("Math overflow")]
    MathOverflow,
}
