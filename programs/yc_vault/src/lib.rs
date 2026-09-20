//! YieldCompass fixed-term senior/junior vault. DEVNET PROTOTYPE, UNAUDITED.
//! Target rate, not guaranteed. The admin key has no path to move vault funds.
use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

pub use instructions::*;

declare_id!("HoLewEAiPuRaJGJXfS4W6uuVRSeeAxC76VGxx3N4YNSW");

#[program]
pub mod yc_vault {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, admin: Pubkey, risk_authority: Pubkey) -> Result<()> {
        init_config_handler(ctx, admin, risk_authority)
    }

    pub fn set_risk_entry(
        ctx: Context<SetRiskEntry>,
        protocol_id: [u8; 32],
        score: u8,
        realized_apy_bps: u32,
        emissions_bps: u16,
        expires_at: i64,
    ) -> Result<()> {
        set_risk_entry_handler(ctx, protocol_id, score, realized_apy_bps, emissions_bps, expires_at)
    }

    pub fn init_series(ctx: Context<InitSeries>, params: InitSeriesParams) -> Result<()> {
        init_series_handler(ctx, params)
    }

    pub fn deposit_senior(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        deposit_senior_handler(ctx, amount)
    }

    pub fn deposit_junior(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        deposit_junior_handler(ctx, amount)
    }

    pub fn activate(ctx: Context<Activate>) -> Result<()> {
        activate_handler(ctx)
    }

    pub fn cancel_series(ctx: Context<CancelSeries>) -> Result<()> {
        cancel_series_handler(ctx)
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        refund_handler(ctx)
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        settle_handler(ctx)
    }

    pub fn claim_senior(ctx: Context<Claim>) -> Result<()> {
        claim_senior_handler(ctx)
    }

    pub fn claim_junior(ctx: Context<Claim>) -> Result<()> {
        claim_junior_handler(ctx)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        set_paused_handler(ctx, paused)
    }
}
