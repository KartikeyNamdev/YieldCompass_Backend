use anchor_lang::prelude::*;

use crate::errors::VaultError;
use crate::events::RiskUpdated;
use crate::state::*;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    pub system_program: Program<'info, System>,
}

pub fn init_config_handler(ctx: Context<InitConfig>, admin: Pubkey, risk_authority: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = admin;
    c.risk_authority = risk_authority;
    c.paused = false;
    c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
#[instruction(protocol_id: [u8; 32])]
pub struct SetRiskEntry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump,
        constraint = config.risk_authority == authority.key() @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(init_if_needed, payer = authority, space = 8 + RiskEntry::INIT_SPACE,
        seeds = [RISK_SEED, protocol_id.as_ref()], bump)]
    pub risk_entry: Box<Account<'info, RiskEntry>>,
    pub system_program: Program<'info, System>,
}

pub fn set_risk_entry_handler(
    ctx: Context<SetRiskEntry>,
    protocol_id: [u8; 32],
    score: u8,
    realized_apy_bps: u32,
    emissions_bps: u16,
    expires_at: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(score <= 100 && emissions_bps <= 10_000 && expires_at > now, VaultError::InvalidParams);
    let r = &mut ctx.accounts.risk_entry;
    r.protocol_id = protocol_id;
    r.score = score;
    r.realized_apy_bps = realized_apy_bps;
    r.emissions_bps = emissions_bps;
    r.updated_at = now;
    r.expires_at = expires_at;
    r.bump = ctx.bumps.risk_entry;
    emit!(RiskUpdated { protocol_id, score, realized_apy_bps, emissions_bps, updated_at: now, expires_at });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump,
        constraint = config.admin == admin.key() @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
}

pub fn set_paused_handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
