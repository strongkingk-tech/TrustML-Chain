"""Small Web3.py helper for the ModelRegistry contract.

Two operations are all the rest of the project needs:

    register(run_id, stage, fingerprint, accuracy_bps)   -> transaction receipt info
    get_record(run_id, stage)                            -> dict, or None if no record

Setup is read from the environment, with local-chain defaults:

    MODEL_REGISTRY_RPC_URL   default http://127.0.0.1:8545
    MODEL_REGISTRY_ADDRESS   default: "address" in deployment/deployment.json
                             (written by `npm run deploy`)

No private keys are used or needed. On the local Hardhat node the accounts are
managed by the node itself, so transactions are sent from a node account. By
default that is account #0, which is the designated registrar after
`npm run deploy`.

Accuracy scale: integer basis points. 6523 means 65.23%. Valid range 0..10000.
Use accuracy_to_bps() / bps_to_accuracy() to convert from and to a 0..1 fraction.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from web3 import Web3
from web3.exceptions import ContractCustomError, ContractLogicError

HERE = Path(__file__).resolve().parent
ABI_PATH = HERE / "abi" / "ModelRegistry.json"
DEPLOYMENT_PATH = HERE / "deployment" / "deployment.json"
DEFAULT_RPC_URL = "http://127.0.0.1:8545"

MAX_ACCURACY_BPS = 10_000
STAGES = (1, 2, 3)


class RegistryError(Exception):
    """Base class for errors raised by this helper."""


class NotRegistrar(RegistryError):
    """The sending account is not the designated registrar."""


class AlreadyRegistered(RegistryError):
    """A record already exists for this run id and stage (never overwritten)."""


class InvalidInput(RegistryError):
    """The contract or this helper rejected the stage, accuracy, run id or fingerprint."""


# --- conversions -------------------------------------------------------------

def accuracy_to_bps(accuracy: float) -> int:
    """Convert a 0..1 accuracy fraction to integer basis points (0.6523 -> 6523)."""
    if not 0.0 <= accuracy <= 1.0:
        raise InvalidInput(f"accuracy must be between 0 and 1, got {accuracy}")
    return round(accuracy * MAX_ACCURACY_BPS)


def bps_to_accuracy(bps: int) -> float:
    """Convert integer basis points to a 0..1 fraction (6523 -> 0.6523)."""
    return bps / MAX_ACCURACY_BPS


def fingerprint_to_bytes32(fingerprint: str) -> bytes:
    """Turn a SHA-256 hex digest (with or without 0x) into the 32 bytes the contract stores."""
    text = fingerprint[2:] if fingerprint.lower().startswith("0x") else fingerprint
    if len(text) != 64:
        raise InvalidInput(f"fingerprint must be 64 hex characters (SHA-256), got {len(text)}")
    try:
        return bytes.fromhex(text)
    except ValueError as exc:
        raise InvalidInput("fingerprint is not valid hex") from exc


# --- connection --------------------------------------------------------------

def _load_address() -> str:
    address = os.environ.get("MODEL_REGISTRY_ADDRESS")
    if address:
        return address
    if DEPLOYMENT_PATH.exists():
        return json.loads(DEPLOYMENT_PATH.read_text())["address"]
    raise RegistryError(
        "No contract address. Run `npm run deploy` in blockchain/ or set MODEL_REGISTRY_ADDRESS."
    )


def get_contract(rpc_url: Optional[str] = None, address: Optional[str] = None):
    """Return a Web3 contract object for the deployed ModelRegistry."""
    w3 = Web3(Web3.HTTPProvider(rpc_url or os.environ.get("MODEL_REGISTRY_RPC_URL", DEFAULT_RPC_URL)))
    if not w3.is_connected():
        raise RegistryError("Cannot reach the local chain. Start it with `npm run node` in blockchain/.")
    abi = json.loads(ABI_PATH.read_text())
    return w3.eth.contract(address=Web3.to_checksum_address(address or _load_address()), abi=abi)


# --- the two operations ------------------------------------------------------

def register(
    run_id: str,
    stage: int,
    fingerprint: str,
    accuracy_bps: int,
    sender: Optional[str] = None,
    contract=None,
) -> dict:
    """Register the official record for one model version.

    Raises NotRegistrar, AlreadyRegistered or InvalidInput on refusal.
    Returns {"tx_hash", "block_number", "gas_used", "submitter"}.
    """
    contract = contract or get_contract()
    w3 = contract.w3
    sender = Web3.to_checksum_address(sender) if sender else w3.eth.accounts[0]
    args = (run_id, stage, fingerprint_to_bytes32(fingerprint), accuracy_bps)
    try:
        tx_hash = contract.functions.register(*args).transact({"from": sender})
    except (ContractCustomError, ContractLogicError) as exc:
        raise _translate(contract, exc) from exc
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    return {
        "tx_hash": tx_hash.hex(),
        "block_number": receipt["blockNumber"],
        "gas_used": receipt["gasUsed"],
        "submitter": sender,
    }


def get_record(run_id: str, stage: int, contract=None) -> Optional[dict]:
    """Look up the record for (run_id, stage).

    Returns None when there is no record (the NO RECORD case). Otherwise a dict:
        fingerprint      64-char lowercase hex SHA-256 (no 0x)
        accuracy_bps     integer, 6523 means 65.23%
        accuracy         float fraction, 0.6523
        registered_at    block timestamp (Unix seconds)
        submitter        checksummed address of the account that registered it
    """
    contract = contract or get_contract()
    exists, fingerprint, accuracy_bps, registered_at, submitter = (
        contract.functions.getRecord(run_id, stage).call()
    )
    if not exists:
        return None
    return {
        "fingerprint": fingerprint.hex(),
        "accuracy_bps": accuracy_bps,
        "accuracy": bps_to_accuracy(accuracy_bps),
        "registered_at": registered_at,
        "submitter": submitter,
    }


# --- error translation -------------------------------------------------------

def _translate(contract, exc: Exception) -> RegistryError:
    """Map a contract revert to a readable Python exception."""
    text = " ".join(str(a) for a in getattr(exc, "args", ())) or str(exc)
    for name, cls in (
        ("NotRegistrar", NotRegistrar),
        ("AlreadyRegistered", AlreadyRegistered),
        ("InvalidStage", InvalidInput),
        ("InvalidAccuracy", InvalidInput),
        ("EmptyRunId", InvalidInput),
        ("EmptyFingerprint", InvalidInput),
    ):
        if name in text:
            return cls(text)
        # Custom errors can arrive as a raw 4-byte selector (0x...) instead of a name.
        selector = Web3.keccak(text=_signature(contract, name))[:4].hex()
        if selector.lower() in text.lower():
            return cls(f"{name} ({text})")
    return RegistryError(text)


def _signature(contract, error_name: str) -> str:
    for item in contract.abi:
        if item.get("type") == "error" and item["name"] == error_name:
            types = ",".join(i["type"] for i in item.get("inputs", []))
            return f"{error_name}({types})"
    return f"{error_name}()"
