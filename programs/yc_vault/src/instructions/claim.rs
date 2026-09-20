use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::errors::VaultError;
use crate::events::{Claimed, Tranche};
use crate::math;
use crate::state::*;

/// Deliberately does not read `Config`: pausing never blocks claims.
#[derive(Accounts)]
pub struct Claim<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [SERIES_SEED, &series.id.to_le_bytes()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, address = series.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(mut, constraint = user_shares.owner == user.key()
        && user_shares.mint == share_mint.key() @ VaultError::InvalidParams)]
    pub user_shares: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = user_underlying.owner == user.key()
        && user_underlying.mint == series.underlying_mint @ VaultError::InvalidParams)]
    pub user_underlying: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

fn claim_inner(ctx: Context<Claim>, tranche: Tranche) -> Result<()> {
    let s = &ctx.accounts.series;
    require!(s.status == Status::Settled, VaultError::WrongStatus);
    let (mint, payout, total_shares) = match tranche {
        Tranche::Senior => (s.senior_mint, s.senior_payout, s.senior_principal),
        Tranche::Junior => (s.junior_mint, s.junior_payout, s.junior_principal),
    };
    require_keys_eq!(ctx.accounts.share_mint.key(), mint, VaultError::InvalidParams);

    // Shares are burned on claim, so a second claim finds a zero balance.
    // The denominator is the ORIGINAL principal (== total shares minted), not the shrinking supply.
    let shares = ctx.accounts.user_shares.amount;
    require!(shares > 0, VaultError::NothingToClaim);
    let amount = math::claim_amount(payout, shares, total_shares).ok_or(VaultError::MathOverflow)?;

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.user_shares.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

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
    emit!(Claimed { series: ctx.accounts.series.key(), user: ctx.accounts.user.key(), tranche, amount });
    Ok(())
}

pub fn claim_senior_handler(ctx: Context<Claim>) -> Result<()> {
    claim_inner(ctx, Tranche::Senior)
}

pub fn claim_junior_handler(ctx: Context<Claim>) -> Result<()> {
    claim_inner(ctx, Tranche::Junior)
}
