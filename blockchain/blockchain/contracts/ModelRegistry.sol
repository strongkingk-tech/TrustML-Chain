// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ModelRegistry
/// @notice Official record book for basketball model versions on a local practice chain.
///         One immutable record per (runId, stage). Only the designated registrar may write.
/// @dev A "model version" is identified by a training run id plus a training stage.
///      Records are append-only: there is no update or delete path.
contract ModelRegistry {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Record {
        bytes32 fingerprint; // SHA-256 of the checkpoint file, computed off-chain
        uint8 stage;         // training stage, 1..MAX_STAGE
        uint16 accuracyBps;  // reported test accuracy in basis points (0..10000)
        uint64 registeredAt; // block timestamp at registration
        bool exists;         // true once registered; distinguishes "no record" from zero values
        address submitter;   // account that submitted the registration (packs into the same slot)
    }

    // ---------------------------------------------------------------------
    // Constants and storage
    // ---------------------------------------------------------------------

    uint8 public constant MAX_STAGE = 3;
    uint16 public constant MAX_ACCURACY_BPS = 10_000;

    /// @notice The only account allowed to register records. Fixed at deployment.
    address public immutable registrar;

    mapping(bytes32 => Record) private records; // key = versionKey(runId, stage)
    uint256 public recordCount;

    // ---------------------------------------------------------------------
    // Events and errors
    // ---------------------------------------------------------------------

    event VersionRegistered(
        bytes32 indexed key,
        string runId,
        uint8 indexed stage,
        bytes32 fingerprint,
        uint16 accuracyBps
    );

    error NotRegistrar(address caller);
    error AlreadyRegistered(string runId, uint8 stage);
    error InvalidStage(uint8 stage);
    error InvalidAccuracy(uint16 accuracyBps);
    error EmptyRunId();
    error EmptyFingerprint();

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param _registrar The designated account. Pass the deployer's address to
    ///        make the deployer the registrar.
    constructor(address _registrar) {
        require(_registrar != address(0), "registrar is zero address");
        registrar = _registrar;
    }

    modifier onlyRegistrar() {
        if (msg.sender != registrar) revert NotRegistrar(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Writing
    // ---------------------------------------------------------------------

    /// @notice Register the official record for one model version.
    /// @dev Reverts if the caller is not the registrar, the inputs are invalid,
    ///      or a record already exists for (runId, stage). Existing records are
    ///      never overwritten.
    function register(
        string calldata runId,
        uint8 stage,
        bytes32 fingerprint,
        uint16 accuracyBps
    ) external onlyRegistrar {
        if (bytes(runId).length == 0) revert EmptyRunId();
        if (stage == 0 || stage > MAX_STAGE) revert InvalidStage(stage);
        if (accuracyBps > MAX_ACCURACY_BPS) revert InvalidAccuracy(accuracyBps);
        if (fingerprint == bytes32(0)) revert EmptyFingerprint();

        bytes32 key = versionKey(runId, stage);
        if (records[key].exists) revert AlreadyRegistered(runId, stage);

        records[key] = Record({
            fingerprint: fingerprint,
            stage: stage,
            accuracyBps: accuracyBps,
            registeredAt: uint64(block.timestamp),
            exists: true,
            submitter: msg.sender
        });
        unchecked {
            recordCount += 1;
        }

        emit VersionRegistered(key, runId, stage, fingerprint, accuracyBps);
    }

    // ---------------------------------------------------------------------
    // Reading
    // ---------------------------------------------------------------------

    /// @notice Deterministic key for a (runId, stage) pair.
    function versionKey(string calldata runId, uint8 stage) public pure returns (bytes32) {
        return keccak256(abi.encode(runId, stage));
    }

    /// @notice True if an official record exists for (runId, stage).
    function isRegistered(string calldata runId, uint8 stage) external view returns (bool) {
        return records[versionKey(runId, stage)].exists;
    }

    /// @notice Fetch the record for (runId, stage).
    /// @dev Never reverts for a missing record. A missing record returns
    ///      exists == false and all other values zero, so a verifier can report
    ///      NO RECORD from a single call without catching a revert.
    function getRecord(string calldata runId, uint8 stage)
        external
        view
        returns (
            bool exists,
            bytes32 fingerprint,
            uint16 accuracyBps,
            uint64 registeredAt,
            address submitter
        )
    {
        Record storage r = records[versionKey(runId, stage)];
        return (r.exists, r.fingerprint, r.accuracyBps, r.registeredAt, r.submitter);
    }
}
