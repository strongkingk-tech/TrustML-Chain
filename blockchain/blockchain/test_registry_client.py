"""Tests for registry_client.py against a RUNNING local chain.

Before running:   npm run node   (terminal 1)   then   npm run deploy   (terminal 2)
Run:              python -m pytest test_registry_client.py -v

Each test uses a fresh run id, so the tests can be repeated on the same chain.
"""

import hashlib
import uuid

import pytest

import registry_client as rc


@pytest.fixture(scope="module")
def contract():
    return rc.get_contract()


def fresh_run() -> str:
    return f"pytest-{uuid.uuid4().hex[:12]}"


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def test_register_then_get_record_round_trip(contract):
    run, fp = fresh_run(), sha256_hex("checkpoint-1")
    info = rc.register(run, 1, fp, 6523, contract=contract)
    assert info["gas_used"] > 0

    record = rc.get_record(run, 1, contract=contract)
    assert record["fingerprint"] == fp
    assert record["accuracy_bps"] == 6523
    assert record["accuracy"] == pytest.approx(0.6523)
    assert record["registered_at"] > 0


def test_record_stores_the_submitting_account(contract):
    run = fresh_run()
    rc.register(run, 1, sha256_hex("a"), 6000, contract=contract)
    record = rc.get_record(run, 1, contract=contract)
    assert record["submitter"] == contract.functions.registrar().call()


def test_missing_record_returns_none_without_error(contract):
    assert rc.get_record(fresh_run(), 1, contract=contract) is None


def test_other_stage_of_same_run_is_a_missing_record(contract):
    run = fresh_run()
    rc.register(run, 1, sha256_hex("a"), 6000, contract=contract)
    assert rc.get_record(run, 2, contract=contract) is None


def test_non_designated_account_is_refused(contract):
    run = fresh_run()
    outsider = contract.w3.eth.accounts[1]
    with pytest.raises(rc.NotRegistrar):
        rc.register(run, 1, sha256_hex("a"), 6000, sender=outsider, contract=contract)
    assert rc.get_record(run, 1, contract=contract) is None


def test_duplicate_is_refused_and_original_kept(contract):
    run, fp = fresh_run(), sha256_hex("original")
    rc.register(run, 1, fp, 6000, contract=contract)
    with pytest.raises(rc.AlreadyRegistered):
        rc.register(run, 1, sha256_hex("different"), 9999, contract=contract)
    record = rc.get_record(run, 1, contract=contract)
    assert record["fingerprint"] == fp
    assert record["accuracy_bps"] == 6000


@pytest.mark.parametrize("stage,bps", [(0, 6000), (4, 6000), (1, 10001)])
def test_invalid_stage_or_accuracy_is_refused(contract, stage, bps):
    with pytest.raises(rc.InvalidInput):
        rc.register(fresh_run(), stage, sha256_hex("a"), bps, contract=contract)


def test_bad_fingerprint_is_refused_before_sending(contract):
    with pytest.raises(rc.InvalidInput):
        rc.register(fresh_run(), 1, "abc123", 6000, contract=contract)
    with pytest.raises(rc.InvalidInput):
        rc.register(fresh_run(), 1, "z" * 64, 6000, contract=contract)


def test_fingerprint_accepts_0x_prefix(contract):
    run, fp = fresh_run(), sha256_hex("prefixed")
    rc.register(run, 1, "0x" + fp, 6000, contract=contract)
    assert rc.get_record(run, 1, contract=contract)["fingerprint"] == fp


def test_accuracy_conversions():
    assert rc.accuracy_to_bps(0.6523) == 6523
    assert rc.accuracy_to_bps(0.0) == 0
    assert rc.accuracy_to_bps(1.0) == 10000
    assert rc.bps_to_accuracy(6523) == pytest.approx(0.6523)
    with pytest.raises(rc.InvalidInput):
        rc.accuracy_to_bps(1.5)
