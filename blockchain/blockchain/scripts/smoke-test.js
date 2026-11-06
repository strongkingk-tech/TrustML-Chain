// Live round trip against the deployed contract on the local node.
// Usage: npx hardhat run scripts/smoke-test.js --network localhost
// Registers one record, reads it back, then shows the two refusals (wrong account, overwrite).
// Uses a run id that includes the current time so it can be re-run on the same chain.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployment", "deployment.json"), "utf8"));
  const [registrar, outsider] = await ethers.getSigners();
  const registry = await ethers.getContractAt("ModelRegistry", dep.address, registrar);

  const run = `smoke-${Date.now()}`;
  const fingerprint = ethers.sha256(ethers.toUtf8Bytes(run));

  console.log("1. register as the designated account");
  await (await registry.register(run, 1, fingerprint, 6523)).wait();

  console.log("2. read it back");
  const [exists, fp, acc, at] = await registry.getRecord(run, 1);
  console.log({ exists, fingerprint: fp, accuracyBps: Number(acc), registeredAt: Number(at) });
  if (!exists || fp !== fingerprint || acc !== 6523n) throw new Error("read-back did not match");

  console.log("3. read a version that was never registered");
  const missing = await registry.getRecord(run, 2);
  console.log({ exists: missing[0] });
  if (missing[0] !== false) throw new Error("expected no record");

  console.log("4. try to register as a different account");
  await registry.connect(outsider).register(`${run}-x`, 1, fingerprint, 5000).then(
    () => { throw new Error("outsider write unexpectedly succeeded"); },
    (e) => console.log("   refused:", /NotRegistrar/.test(e.message) ? "NotRegistrar" : e.message)
  );

  console.log("5. try to overwrite the existing record");
  await registry.register(run, 1, ethers.sha256("0xdeadbeef"), 9999).then(
    () => { throw new Error("overwrite unexpectedly succeeded"); },
    (e) => console.log("   refused:", /AlreadyRegistered/.test(e.message) ? "AlreadyRegistered" : e.message)
  );

  const after = await registry.getRecord(run, 1);
  if (after[1] !== fingerprint) throw new Error("record changed after refused overwrite");
  console.log("6. original record unchanged. Smoke test passed.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
