use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const SERIES_SEED: &[u8] = b"series";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SENIOR_MINT_SEED: &[u8] = b"senior_mint";
pub const JUNIOR_MINT_SEED: &[u8] = b"junior_mint";
pub const RISK_SEED: &[u8] = b"risk";

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Can create series and pause. CANNOT move vault funds.
    pub admin: Pubkey,
    /// Only key allowed to write RiskEntry.
    pub risk_authority: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RiskEntry {
    pub protocol_id: [u8; 32],
    /// 0-100, higher = safer.
    pub score: u8,
    pub realized_apy_bps: u32,
    /// Share of headline yield from emissions.
    pub emissions_bps: u16,
    pub updated_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Status {
    Open,
    Active,
    Settled,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct Series {
    pub id: u64,
    pub underlying_mint: Pubkey,
    pub senior_mint: Pubkey,
    pub junior_mint: Pubkey,
    pub vault: Pubkey,
    pub strategy_pool: Pubkey,
    pub risk_entry: Pubkey,
    pub rate_bps: u16,
    pub term_secs: i64,
    pub deposit_deadline: i64,
    pub start_ts: i64,
    pub maturity_ts: i64,
    pub min_junior_bps: u16,
    pub min_risk_score: u8,
    pub senior_principal: u64,
    pub junior_principal: u64,
    pub senior_payout: u64,
    pub junior_payout: u64,
    pub performance_fee_bps: u16,
    pub status: Status,
    pub bump: u8,
}

impl Series {
    /// Activation gate shared by `activate` and `cancel_series`.
    /// Returns Ok(()) only if the series may be activated right now (ignoring pause).
    pub fn check_activation(&self, risk: &RiskEntry, now: i64) -> Result<()> {
        use crate::errors::VaultError;
        require!(
            self.senior_principal.checked_add(self.junior_principal).ok_or(VaultError::MathOverflow)? > 0,
            VaultError::InvalidParams
        );
        require!(
            crate::math::junior_ratio_ok(self.senior_principal, self.junior_principal, self.min_junior_bps),
            VaultError::JuniorBufferTooSmall
        );
        require!(now < risk.expires_at, VaultError::RiskEntryStale);
        require!(risk.score >= self.min_risk_score, VaultError::RiskScoreTooLow);
        Ok(())
    }
}
