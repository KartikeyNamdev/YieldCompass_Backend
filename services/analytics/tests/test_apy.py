from datetime import datetime, timedelta, timezone

import pytest

from app.apy import PricePoint, RatePoint, emissions, realized_apy, risk_adjusted_yield

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def pts(*rates_days: tuple[float, float]) -> list[RatePoint]:
    return [RatePoint(T0 + timedelta(days=d), r) for r, d in rates_days]


def test_realized_apy_hand_calculation():
    # share rate 1.00 -> 1.01 in 30 days: period return 1%, annualised (1.01)^(365/30) - 1
    r = realized_apy(pts((1.00, 0), (1.01, 30)), window_days=30)
    assert r.period_return == pytest.approx(0.01)
    assert r.days == pytest.approx(30)
    assert r.apy == pytest.approx(0.128695, abs=1e-6)  # exp(ln(1.01) * 365/30) - 1 = exp(0.121061) - 1


def test_realized_apy_365_day_window_equals_period_return():
    r = realized_apy(pts((1.0, 0), (1.05, 365)), window_days=365)
    assert r.apy == pytest.approx(0.05)


def test_window_ignores_older_points_and_uses_actual_elapsed_days():
    r = realized_apy(pts((1.00, 0), (1.10, 20), (1.11, 26), (1.12, 30)), window_days=7)
    assert r.days == pytest.approx(4)  # only the points at day 26 and day 30 are inside a 7d window
    assert r.period_return == pytest.approx(1.12 / 1.11 - 1)


def test_negative_return_is_negative_apy():
    assert realized_apy(pts((1.0, 0), (0.99, 30)), 30).apy < 0


@pytest.mark.parametrize("series", [pts((1.0, 0)), pts((1.0, 0), (1.0, 0.1)), pts((0.0, 0), (1.0, 10))])
def test_rejects_bad_input(series):
    with pytest.raises(ValueError):
        realized_apy(series, 30)


def test_emissions_share_and_haircut():
    prices = [PricePoint(T0, 1.0), PricePoint(T0 + timedelta(days=30), 0.55)]
    e = emissions(base_apy=0.031, reward_apy=0.349, prices=prices)
    assert e.emissions_share == pytest.approx(0.349 / 0.38)
    assert e.haircut == pytest.approx(0.55)
    assert e.sustainable_apy == pytest.approx(0.031 + 0.349 * 0.55)
    assert e.haircut_basis == "price_change_30d"


def test_haircut_is_capped_at_one_and_floored_at_zero():
    up = emissions(0.05, 0.05, [PricePoint(T0, 1.0), PricePoint(T0 + timedelta(days=30), 3.0)])
    crash = emissions(0.05, 0.05, [PricePoint(T0, 1.0), PricePoint(T0 + timedelta(days=30), 0.0001)])
    assert up.haircut == 1.0
    assert crash.haircut == pytest.approx(0.0001)
    assert emissions(0.05, 0.05, [PricePoint(T0, 1.0), PricePoint(T0 + timedelta(days=30), 1e-12)]).haircut >= 0.0


def test_no_price_data_uses_conservative_default_and_zero_total_is_safe():
    e = emissions(0.04, 0.04)
    assert e.haircut == 0.5 and e.haircut_basis == "no_price_data"
    assert emissions(0.0, 0.0).emissions_share == 0.0


def test_risk_adjusted_yield():
    assert risk_adjusted_yield(0.10, 80) == pytest.approx(0.08)
