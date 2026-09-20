use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::VaultError;
use crate::events::SeriesCreated;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitSeriesParams {
    pub id: u64,
    pub rate_bps: u16,
    pub term_secs: i64,
    pub deposit_deadline: i64,
    pub min_junior_bps: u16,
    pub min_risk_score: u8,
    pub performance_fee_bps: u16,
}

#[derive(Accounts)]
#[instruction(params: InitSeriesParams)]
pub struct InitSeries<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = config.admin == admin.key() @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    pub underlying_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, space = 8 + Series::INIT_SPACE,
        seeds = [SERIES_SEED, &params.id.to_le_bytes()], bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(init, payer = admin, seeds = [VAULT_SEED, series.key().as_ref()], bump,
        token::mint = underlying_mint, token::authority = series)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = admin, seeds = [SENIOR_MINT_SEED, series.key().as_ref()], bump,
        mint::decimals = underlying_mint.decimals, mint::authority = series)]
    pub senior_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = admin, seeds = [JUNIOR_MINT_SEED, series.key().as_ref()], bump,
        mint::decimals = underlying_mint.decimals, mint::authority = series)]
    pub junior_mint: Box<Account<'info, Mint>>,
    /// The mock_yield pool. Must be bound to this series PDA and the same mint.
    pub strategy_pool: Box<Account<'info, mock_yield::Pool>>,
    pub risk_entry: Box<Account<'info, RiskEntry>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn init_series_handler(ctx: Context<InitSeries>, p: InitSeriesParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(p.rate_bps <= 5000, VaultError::InvalidParams);
    require!(p.term_secs > 0, VaultError::InvalidParams);
    require!((500..=5000).contains(&p.min_junior_bps), VaultError::InvalidParams);
    require!(p.min_risk_score <= 100, VaultError::InvalidParams);
    require!(p.deposit_deadline > now, VaultError::InvalidParams);
    // Performance fee collection is phase 2 (cut line 4): no recipient exists, so it must be 0.
    require!(p.performance_fee_bps == 0, VaultError::InvalidParams);

    let series_key = ctx.accounts.series.key();
    let pool = &ctx.accounts.strategy_pool;
    require!(
        pool.depositor == series_key && pool.mint == ctx.accounts.underlying_mint.key(),
        VaultError::InvalidParams
    );

    let s = &mut ctx.accounts.series;
    s.id = p.id;
    s.underlying_mint = ctx.accounts.underlying_mint.key();
    s.senior_mint = ctx.accounts.senior_mint.key();
    s.junior_mint = ctx.accounts.junior_mint.key();
    s.vault = ctx.accounts.vault.key();
    s.strategy_pool = ctx.accounts.strategy_pool.key();
    s.risk_entry = ctx.accounts.risk_entry.key();
    s.rate_bps = p.rate_bps;
    s.term_secs = p.term_secs;
    s.deposit_deadline = p.deposit_deadline;
    s.start_ts = 0;
    s.maturity_ts = 0;
    s.min_junior_bps = p.min_junior_bps;
    s.min_risk_score = p.min_risk_score;
    s.senior_principal = 0;
    s.junior_principal = 0;
    s.senior_payout = 0;
    s.junior_payout = 0;
    s.performance_fee_bps = p.performance_fee_bps;
    s.status = Status::Open;
    s.bump = ctx.bumps.series;

    emit!(SeriesCreated {
        series: series_key,
        id: p.id,
        rate_bps: p.rate_bps,
        term_secs: p.term_secs,
        deposit_deadline: p.deposit_deadline,
        min_junior_bps: p.min_junior_bps,
        min_risk_score: p.min_risk_score,
    });
    Ok(())
}
