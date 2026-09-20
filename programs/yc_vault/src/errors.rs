use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Program is paused")]
    Paused,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Deposit window is closed")]
    DepositWindowClosed,
    #[msg("Deposit window is still open")]
    DepositWindowOpen,
    #[msg("Wrong series status")]
    WrongStatus,
    #[msg("Junior buffer too small")]
    JuniorBufferTooSmall,
    #[msg("Risk entry is stale")]
    RiskEntryStale,
    #[msg("Risk score below series minimum")]
    RiskScoreTooLow,
    #[msg("Series has not matured")]
    NotMatured,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Activation conditions are met; series cannot be cancelled")]
    ActivationConditionsMet,
}
