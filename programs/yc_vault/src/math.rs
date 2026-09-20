//! Pure waterfall math. Mirrored 1:1 in `packages/waterfall` (TypeScript).
//! All arithmetic is checked and uses u128 intermediates.

pub const BPS: u128 = 10_000;
pub const SECS_PER_YEAR: u128 = 31_536_000;

/// Principal + simple interest for the term. None on overflow.
pub fn senior_owed(principal: u64, rate_bps: u16, term_secs: i64) -> Option<u64> {
    if term_secs < 0 {
        return None;
    }
    let p = principal as u128;
    let interest = p
        .checked_mul(rate_bps as u128)?
        .checked_mul(term_secs as u128)?
        .checked_div(BPS.checked_mul(SECS_PER_YEAR)?)?;
    u64::try_from(p.checked_add(interest)?).ok()
}

/// (senior_payout, junior_payout). Always sums to total_assets.
pub fn waterfall(total_assets: u64, senior_owed: u64) -> (u64, u64) {
    let senior = total_assets.min(senior_owed);
    (senior, total_assets - senior)
}

/// Pro-rata share of a tranche payout. Rounds DOWN (dust stays in vault).
pub fn claim_amount(payout_total: u64, user_shares: u64, total_shares: u64) -> Option<u64> {
    if total_shares == 0 {
        return None;
    }
    let v = (payout_total as u128)
        .checked_mul(user_shares as u128)?
        .checked_div(total_shares as u128)?;
    u64::try_from(v).ok()
}

/// True if the junior buffer is large enough.
pub fn junior_ratio_ok(senior: u64, junior: u64, min_junior_bps: u16) -> bool {
    let total = (senior as u128) + (junior as u128);
    if total == 0 {
        return true;
    }
    (junior as u128) * BPS >= total * (min_junior_bps as u128)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const YEAR: i64 = 31_536_000;
    // 6-decimal units: $1 = 1_000_000
    const D: u64 = 1_000_000;

    #[test]
    fn senior_owed_one_year_two_percent() {
        assert_eq!(senior_owed(100 * D, 200, YEAR), Some(102 * D));
    }

    #[test]
    fn senior_owed_rejects_negative_term_and_overflow() {
        assert_eq!(senior_owed(1, 200, -1), None);
        assert_eq!(senior_owed(u64::MAX, 5000, YEAR), None);
    }

    /// Section 4.3 table: senior $100, junior $10, rate 2%, 1 year.
    #[test]
    fn waterfall_table_rows() {
        let owed = senior_owed(100 * D, 200, YEAR).unwrap();
        // (underlying result bps, total assets, senior, junior) in $ * 100
        let rows: [(i64, u64, u64, u64); 5] = [
            (600, 11_660, 10_200, 1_460),
            (200, 11_220, 10_200, 1_020),
            (0, 11_000, 10_200, 800),
            (-500, 10_450, 10_200, 250),
            (-1000, 9_900, 9_900, 0),
        ];
        for (bps, total, s, j) in rows {
            let assets = ((110 * D) as i128 * (10_000 + bps) as i128 / 10_000) as u64;
            assert_eq!(assets, total * D / 100, "assets for {bps} bps");
            let (sp, jp) = waterfall(assets, owed);
            assert_eq!(sp, s * D / 100, "senior at {bps} bps");
            assert_eq!(jp, j * D / 100, "junior at {bps} bps");
        }
    }

    #[test]
    fn claim_rounds_down() {
        assert_eq!(claim_amount(100, 1, 3), Some(33));
        assert_eq!(claim_amount(100, 1, 0), None);
        assert_eq!(claim_amount(1_000, 3, 3), Some(1_000));
    }

    #[test]
    fn capacity_rule() {
        // 10% min junior: senior at most 9x junior
        assert!(junior_ratio_ok(90, 10, 1000));
        assert!(!junior_ratio_ok(91, 10, 1000));
        assert!(junior_ratio_ok(0, 0, 1000));
    }

    proptest! {
        // Invariants 1 and 2
        #[test]
        fn payouts_conserve_and_cap(assets in 0u64..u64::MAX / 2, owed in 0u64..u64::MAX / 2) {
            let (s, j) = waterfall(assets, owed);
            prop_assert_eq!(s + j, assets);
            prop_assert!(s <= owed);
            // junior is paid only after senior is made whole
            if j > 0 { prop_assert_eq!(s, owed); }
        }

        // Invariant 4: sum of all pro-rata claims <= payout
        #[test]
        fn claims_never_exceed_payout(
            payout in 0u64..1_000_000_000_000u64,
            shares in proptest::collection::vec(1u64..1_000_000_000u64, 1..20),
        ) {
            let total: u64 = shares.iter().sum();
            let paid: u64 = shares.iter().map(|s| claim_amount(payout, *s, total).unwrap()).sum();
            prop_assert!(paid <= payout);
            prop_assert!(payout - paid < shares.len() as u64); // dust bounded by claimant count
        }

        // Invariant 5: a passing ratio check means junior share >= min bps
        #[test]
        fn ratio_check_matches_definition(s in 0u64..u64::MAX / 4, j in 0u64..u64::MAX / 4, bps in 500u16..=5000) {
            let ok = junior_ratio_ok(s, j, bps);
            let total = s as u128 + j as u128;
            prop_assert_eq!(ok, total == 0 || (j as u128) * 10_000 >= total * bps as u128);
        }

        #[test]
        fn senior_owed_at_least_principal(p in 0u64..u64::MAX / 2, r in 0u16..=5000, t in 0i64..10 * YEAR) {
            if let Some(o) = senior_owed(p, r, t) { prop_assert!(o >= p); }
        }
    }
}
