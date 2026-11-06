# blockchain/ : Smart Contract and Local Blockchain (Kaleb)

**Status: built and tested** on a local Hardhat chain (Hardhat 2.x, Solidity 0.8.24, Node 22, Python 3.13, Web3.py 8.0.0). The commands in "How to run" are the ones that were run and passed. Nothing here has been run on a public network.

## What is in this folder

```
contracts/ModelRegistry.sol      the smart contract
test/ModelRegistry.test.js       23 contract tests (Hardhat)
scripts/deploy.js                deploys to the local node, exports the ABI and address
scripts/smoke-test.js            live round trip against the deployed contract
scripts/gas-report.js            gas measurements (writes gas-report.md / .json)
abi/ModelRegistry.json           exported contract interface for Python (tracked in Git)
registry_client.py               Web3.py helper: register(...) and get_record(...)
test_registry_client.py          12 Python tests, run against the live local chain
requirements.txt                 Python packages (web3, pytest)
hardhat.config.js                compiler settings (see "Offline compiler")
gas-report.md / gas-report.json  most recent gas measurements
```

**Not committed** (see `.gitignore`): `node_modules/`, `cache/`, `artifacts/`, `deployment/` (local chain address, changes on every fresh chain), `.env`. There are no private keys anywhere in this folder, and none are needed (see "Accounts and keys").

## Contract rules (from `docs/SYSTEM_DESIGN.md`)

| # | Rule | How it is done |
| --- | --- | --- |
| 1 | Records identified by training run and stage | Key is a hash of (run id, stage). Stage is 1, 2 or 3 |
| 2 | Store the model fingerprint and reported accuracy | `fingerprint` (32-byte SHA-256) and `accuracyBps` (integer, scale below) |
| 3 | Record the submitting account | `submitter` is set to `msg.sender` when the record is written and returned by `getRecord` |
| 4 | Only the designated account may register | `registrar` is fixed at deployment (`immutable`). Any other sender is refused with `NotRegistrar` |
| 5 | Reject duplicate run-and-stage registration | A second write to the same (run id, stage) is refused with `AlreadyRegistered`, identical data or not. There is no update or delete function |
| 6 | Clear response for a missing record | `getRecord` never reverts. A missing record returns `exists = false` and zero values. The Python `get_record` returns `None` |

Other refusals: `InvalidStage` (not 1 to 3), `InvalidAccuracy` (over 10000), `EmptyRunId`, `EmptyFingerprint` (all zeros).

### Accuracy scale

Accuracy is stored as an **integer in basis points (hundredths of a percent)**: `6523` means **65.23%**, `10000` means 100%, `0` means 0%. Valid range is 0 to 10000. Solidity has no floating point, so this keeps the value exact. In Python, `accuracy_to_bps(0.6523)` gives `6523` and `bps_to_accuracy(6523)` gives `0.6523`.

*(This same paragraph belongs in `docs/SYSTEM_DESIGN.md`.)*

### Contract interface

```solidity
register(string runId, uint8 stage, bytes32 fingerprint, uint16 accuracyBps)      // registrar only

getRecord(string runId, uint8 stage) returns (
    bool exists, bytes32 fingerprint, uint16 accuracyBps, uint64 registeredAt, address submitter)
isRegistered(string runId, uint8 stage) returns (bool)
registrar() returns (address)
recordCount() returns (uint256)

event VersionRegistered(bytes32 indexed key, string runId, uint8 indexed stage, bytes32 fingerprint, uint16 accuracyBps)
```

## Python helper

`registry_client.py` has the two operations the rest of the project needs.

```python
import registry_client as rc

# Write (sent from the designated account by default)
info = rc.register("run-007", 1, sha256_hex_digest, rc.accuracy_to_bps(0.6523))
# -> {"tx_hash": ..., "block_number": ..., "gas_used": ..., "submitter": ...}

# Read
record = rc.get_record("run-007", 1)
# -> {"fingerprint": "<64 hex>", "accuracy_bps": 6523, "accuracy": 0.6523,
#     "registered_at": <unix seconds>, "submitter": "0x..."}
# -> None when there is no record (the NO RECORD case)
```

For the verify command:

```python
record = rc.get_record(run_id, stage)
if record is None:                       verdict = "NO RECORD"
elif record["fingerprint"] == local_hex: verdict = "MATCH"
else:                                    verdict = "CHANGED"
```

`local_hex` is the 64-character lowercase SHA-256 hex digest (`hashlib.sha256(...).hexdigest()`). A leading `0x` is accepted on input to `register`.

Refusals raise Python exceptions: `rc.NotRegistrar`, `rc.AlreadyRegistered`, `rc.InvalidInput` (all subclasses of `rc.RegistryError`). A fingerprint that is not 64 hex characters is rejected before anything is sent.

Configuration, all optional on the local chain:

| Variable | Default |
| --- | --- |
| `MODEL_REGISTRY_RPC_URL` | `http://127.0.0.1:8545` |
| `MODEL_REGISTRY_ADDRESS` | the `address` in `deployment/deployment.json`, written by `npm run deploy` |

## How to run

Run from the `blockchain/` folder. These are the exact commands that were run.

**1. Install (once)**

```
npm install
pip install -r requirements.txt
```

**2. Compile and test the contract** (no node needed)

```
npm run compile
npm test
```

Expected: `Compiled 1 Solidity file successfully` and `23 passing`.

**3. Start the local chain and deploy** (two terminals)

```
# Terminal 1: leave running. This is the local practice blockchain.
npm run node

# Terminal 2:
npm run deploy      # deploys, writes abi/ModelRegistry.json and deployment/deployment.json
npm run smoke       # register, read back, then both refusals, against the live chain
python -m pytest test_registry_client.py -v     # Python helper tests, expects 12 passed
```

On a fresh node, `npm run deploy` prints address `0x5FbDB2315678afecb367f032d93F642f64180aa3` and registrar `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`. Restarting the node wipes the chain, so run `npm run deploy` again after a restart.

**4. Gas measurements** (no node needed)

```
npm run gas
```

## Accounts and keys

The local Hardhat node creates 20 test accounts and manages them itself, so transactions are sent from a node account and no private key is read or stored by this code. Account #0 (`0xf39F…2266`) deploys the contract and is therefore the designated registrar. Account #1 is used in tests as the "wrong account". These are well-known public test accounts. Never use them on a real network, and never commit a `.env` or key file.

## Gas usage

Measured on Hardhat's local chain, optimizer on (200 runs). Units are gas, not money; gas is free on the local chain.

| Operation | Gas used | Note |
| --- | ---: | --- |
| Deploy contract | 440,373 | one time |
| register (stage 1, first record in contract) | 93,882 | first write also moves `recordCount` from 0 to 1 |
| register (stage 2) | 76,782 | |
| register (stage 3) | 76,782 | |
| register (58-char run id) | 77,749 | longer id costs a little more calldata and event data |
| register rejected: duplicate record | 26,211 | gas is still charged on a revert |
| register rejected: not the registrar | 24,340 | gas is still charged on a revert |
| getRecord / isRegistered as a transaction | 27,397 / 25,034 | includes 21,000 base. Called off-chain it is free, which is how Python reads |
| Register all 3 stages of one run (total) | 247,422 | |

Each record uses two storage slots, which is most of the roughly 77k gas for a write. Storing the submitter added only about 85 gas per write because it fits in the same slot as the stage, accuracy, timestamp and flag.

## Limitations

- **The contract trusts the registrar.** It cannot check that a fingerprint is really the SHA-256 of a file or that the accuracy is true. It guarantees that once written, a record cannot change, and that only the designated account could write it.
- **The designated account cannot be changed.** If its key is lost or leaked, deploy a new contract and re-register.
- **A wrong record cannot be corrected.** Use a new run id.
- **Submitter equals registrar.** Because only the registrar can write, the stored submitter will always be that account. It is recorded because the design asks for it, and it keeps the record meaningful if the access rule is ever widened.
- **Local chain only.** The node's state resets when it stops.
- **Stages are fixed at 1 to 3** (`MAX_STAGE` in the contract). Changing that means editing the constant and redeploying.

## Offline compiler

Hardhat normally downloads its Solidity compiler from `binaries.soliditylang.org`. That host was blocked where this was built, so `hardhat.config.js` points Hardhat at the compiler bundled in the `solc` npm package, pinned to 0.8.24 and installed by `npm install`. If your machine can reach the download host, you can delete the `subtask(...)` block in `hardhat.config.js` and Hardhat will fetch the same version itself.
