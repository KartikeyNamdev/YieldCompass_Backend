use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Tranche {
    Senior,
    Junior,
}

#[event]
pub struct SeriesCreated {
    pub series: Pubkey,
    pub id: u64,
    pub rate_bps: u16,
    pub term_secs: i64,
    pub deposit_deadline: i64,
    pub min_junior_bps: u16,
    pub min_risk_score: u8,
}

#[event]
pub struct Deposited {
    pub series: Pubkey,
    pub user: Pubkey,
    pub tranche: Tranche,
    pub amount: u64,
}

#[event]
pub struct Activated {
    pub series: Pubkey,
    pub start_ts: i64,
    pub maturity_ts: i64,
    pub deployed: u64,
}

#[event]
pub struct Cancelled {
    pub series: Pubkey,
}

#[event]
pub struct Settled {
    pub series: Pubkey,
    pub total_assets: u64,
    pub senior_payout: u64,
    pub junior_payout: u64,
}

#[event]
pub struct Claimed {
    pub series: Pubkey,
    pub user: Pubkey,
    pub tranche: Tranche,
    pub amount: u64,
}

#[event]
pub struct Refunded {
    pub series: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RiskUpdated {
    pub protocol_id: [u8; 32],
    pub score: u8,
    pub realized_apy_bps: u32,
    pub emissions_bps: u16,
    pub updated_at: i64,
    pub expires_at: i64,
}
