const { expect } = require("chai");
const { ethers } = require("hardhat");

// Stand-in SHA-256 fingerprints (32 bytes each). The real ones come from the
// off-chain fingerprint code; the contract only stores and compares them.
const FP_A = ethers.sha256(ethers.toUtf8Bytes("checkpoint-stage1"));
const FP_B = ethers.sha256(ethers.toUtf8Bytes("checkpoint-stage2"));
const FP_TAMPERED = ethers.sha256(ethers.toUtf8Bytes("checkpoint-stage1-tampered"));

describe("ModelRegistry", function () {
  let registry, registrar, outsider, other;

  beforeEach(async function () {
    [registrar, outsider, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ModelRegistry");
    registry = await Factory.deploy(registrar.address);
    await registry.waitForDeployment();
  });

  describe("deployment", function () {
    it("sets the designated registrar and starts empty", async function () {
      expect(await registry.registrar()).to.equal(registrar.address);
      expect(await registry.recordCount()).to.equal(0n);
    });

    it("lets the registrar be a different account than the deployer", async function () {
      const Factory = await ethers.getContractFactory("ModelRegistry", outsider);
      const r = await Factory.deploy(other.address);
      await r.waitForDeployment();
      expect(await r.registrar()).to.equal(other.address);
      // the deployer (outsider) has no write power
      await expect(r.connect(outsider).register("run-1", 1, FP_A, 9000))
        .to.be.revertedWithCustomError(r, "NotRegistrar");
      await expect(r.connect(other).register("run-1", 1, FP_A, 9000)).to.not.be.reverted;
    });

    it("rejects the zero address as registrar", async function () {
      const Factory = await ethers.getContractFactory("ModelRegistry");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith("registrar is zero address");
    });
  });

  describe("registration and retrieval", function () {
    it("stores fingerprint, stage and accuracy and returns them", async function () {
      await registry.register("run-007", 1, FP_A, 6523);
      const [exists, fingerprint, accuracyBps, registeredAt] = await registry.getRecord("run-007", 1);
      expect(exists).to.equal(true);
      expect(fingerprint).to.equal(FP_A);
      expect(accuracyBps).to.equal(6523n);
      expect(registeredAt).to.be.greaterThan(0n);
      expect(await registry.recordCount()).to.equal(1n);
    });

    it("records the submitting account", async function () {
      await registry.register("run-007", 1, FP_A, 6523);
      const record = await registry.getRecord("run-007", 1);
      expect(record[4]).to.equal(registrar.address);
    });

    it("emits VersionRegistered with the right fields", async function () {
      const key = await registry.versionKey("run-007", 2);
      await expect(registry.register("run-007", 2, FP_B, 7100))
        .to.emit(registry, "VersionRegistered")
        .withArgs(key, "run-007", 2, FP_B, 7100);
    });

    it("isRegistered reflects what has been written", async function () {
      expect(await registry.isRegistered("run-007", 1)).to.equal(false);
      await registry.register("run-007", 1, FP_A, 6500);
      expect(await registry.isRegistered("run-007", 1)).to.equal(true);
      expect(await registry.isRegistered("run-007", 2)).to.equal(false);
      expect(await registry.isRegistered("run-008", 1)).to.equal(false);
    });

    it("returns exists=false and zero values for an unregistered version", async function () {
      // must not revert: a missing record is a normal answer, not an error
      const [exists, fingerprint, accuracyBps, registeredAt, submitter] = await registry.getRecord("never-ran", 3);
      expect(exists).to.equal(false);
      expect(fingerprint).to.equal(ethers.ZeroHash);
      expect(accuracyBps).to.equal(0n);
      expect(registeredAt).to.equal(0n);
      expect(submitter).to.equal(ethers.ZeroAddress);
    });

    it("keeps the three stages of one run as separate records", async function () {
      await registry.register("run-007", 1, FP_A, 6000);
      await registry.register("run-007", 2, FP_B, 6500);
      await registry.register("run-007", 3, ethers.sha256("0x03"), 6800);
      expect((await registry.getRecord("run-007", 1))[1]).to.equal(FP_A);
      expect((await registry.getRecord("run-007", 2))[1]).to.equal(FP_B);
      expect((await registry.getRecord("run-007", 3))[2]).to.equal(6800n);
      expect(await registry.recordCount()).to.equal(3n);
    });

    it("keeps the same stage of different runs as separate records", async function () {
      await registry.register("run-A", 1, FP_A, 6000);
      await registry.register("run-B", 1, FP_B, 7000);
      expect((await registry.getRecord("run-A", 1))[1]).to.equal(FP_A);
      expect((await registry.getRecord("run-B", 1))[1]).to.equal(FP_B);
    });

    it("accepts the accuracy boundaries 0 and 10000", async function () {
      await registry.register("run-lo", 1, FP_A, 0);
      await registry.register("run-hi", 1, FP_B, 10000);
      expect((await registry.getRecord("run-hi", 1))[2]).to.equal(10000n);
    });

    it("supports the MATCH / CHANGED / NO RECORD decision a verifier makes", async function () {
      await registry.register("run-007", 1, FP_A, 6523);
      const verdict = async (run, stage, localFp) => {
        const [exists, onChain] = await registry.getRecord(run, stage);
        if (!exists) return "NO RECORD";
        return onChain === localFp ? "MATCH" : "CHANGED";
      };
      expect(await verdict("run-007", 1, FP_A)).to.equal("MATCH");
      expect(await verdict("run-007", 1, FP_TAMPERED)).to.equal("CHANGED");
      expect(await verdict("run-007", 2, FP_A)).to.equal("NO RECORD");
    });
  });

  describe("access control", function () {
    it("refuses a non-registrar account and writes nothing", async function () {
      await expect(registry.connect(outsider).register("run-007", 1, FP_A, 6523))
        .to.be.revertedWithCustomError(registry, "NotRegistrar")
        .withArgs(outsider.address);
      expect(await registry.isRegistered("run-007", 1)).to.equal(false);
      expect(await registry.recordCount()).to.equal(0n);
    });

    it("has no function that could hand the role to someone else", async function () {
      const names = registry.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      for (const banned of ["setRegistrar", "transferOwnership", "changeRegistrar", "renounceOwnership"]) {
        expect(names).to.not.include(banned);
      }
    });
  });

  describe("no overwrites and no duplicates", function () {
    beforeEach(async function () {
      await registry.register("run-007", 1, FP_A, 6523);
    });

    it("refuses an exact duplicate", async function () {
      await expect(registry.register("run-007", 1, FP_A, 6523))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered")
        .withArgs("run-007", 1);
    });

    it("refuses an overwrite with a different fingerprint and keeps the original", async function () {
      await expect(registry.register("run-007", 1, FP_TAMPERED, 9999))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered");
      const [, fingerprint, accuracyBps] = await registry.getRecord("run-007", 1);
      expect(fingerprint).to.equal(FP_A);
      expect(accuracyBps).to.equal(6523n);
      expect(await registry.recordCount()).to.equal(1n);
    });

    it("refuses an overwrite that changes only the accuracy", async function () {
      await expect(registry.register("run-007", 1, FP_A, 9000))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered");
      expect((await registry.getRecord("run-007", 1))[2]).to.equal(6523n);
    });

    it("exposes no update or delete function", async function () {
      const names = registry.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      for (const banned of ["update", "overwrite", "remove", "delete", "set", "revoke"]) {
        expect(names).to.not.include(banned);
      }
      // the only state-changing function is register
      const writers = registry.interface.fragments
        .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
        .map((f) => f.name);
      expect(writers).to.deep.equal(["register"]);
    });
  });

  describe("input validation", function () {
    it("rejects stage 0 and stages above 3", async function () {
      await expect(registry.register("run-007", 0, FP_A, 6000))
        .to.be.revertedWithCustomError(registry, "InvalidStage").withArgs(0);
      await expect(registry.register("run-007", 4, FP_A, 6000))
        .to.be.revertedWithCustomError(registry, "InvalidStage").withArgs(4);
    });

    it("rejects accuracy above 10000 basis points", async function () {
      await expect(registry.register("run-007", 1, FP_A, 10001))
        .to.be.revertedWithCustomError(registry, "InvalidAccuracy").withArgs(10001);
    });

    it("rejects an empty run id", async function () {
      await expect(registry.register("", 1, FP_A, 6000))
        .to.be.revertedWithCustomError(registry, "EmptyRunId");
    });

    it("rejects an all-zero fingerprint", async function () {
      await expect(registry.register("run-007", 1, ethers.ZeroHash, 6000))
        .to.be.revertedWithCustomError(registry, "EmptyFingerprint");
    });

    it("does not let a rejected input consume the slot", async function () {
      await expect(registry.register("run-007", 1, FP_A, 10001)).to.be.reverted;
      await expect(registry.register("run-007", 1, FP_A, 6000)).to.not.be.reverted;
    });
  });
});
