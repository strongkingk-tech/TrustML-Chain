// Measures gas for each ModelRegistry operation on Hardhat's in-process local chain.
// Usage: npx hardhat run scripts/gas-report.js
// Writes gas-report.json and gas-report.md to the project root.

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const fp = (label) => ethers.sha256(ethers.toUtf8Bytes(label));

async function used(txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  return Number(receipt.gasUsed);
}

// A transaction that reverts still costs gas. Send it with a fixed gas limit so
// the node mines it (instead of rejecting it at estimation time) and read gasUsed.
async function revertedGas(contract, signer, args) {
  const data = contract.interface.encodeFunctionData("register", args);
  let threw = false;
  try {
    await signer.sendTransaction({
      to: await contract.getAddress(),
      data,
      gasLimit: 500_000,
    });
  } catch (e) {
    // Hardhat's automine throws on a revert, but the transaction is still mined
    // and charged. Read it back from the latest block.
    threw = true;
  }
  if (!threw) throw new Error("expected a reverted transaction");
  const block = await ethers.provider.getBlock("latest");
  const receipt = await ethers.provider.getTransactionReceipt(block.transactions[0]);
  if (!receipt || receipt.status !== 0) throw new Error("latest transaction was not a revert");
  return Number(receipt.gasUsed);
}

async function main() {
  const [registrar, outsider] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("ModelRegistry");

  const results = [];
  const add = (operation, gas, note = "") => results.push({ operation, gas, note });

  // Deployment
  const registry = await Factory.deploy(registrar.address);
  const deployReceipt = await registry.deploymentTransaction().wait();
  add("Deploy contract", Number(deployReceipt.gasUsed), "one time");

  // Registrations: the three stages of one run, with a typical run id
  const run = "nba-run-007"; // 11 characters
  add("register (stage 1, first record in contract)",
    await used(registry.register(run, 1, fp("s1"), 6523)), "first write also sets recordCount from 0 to 1");
  add("register (stage 2)", await used(registry.register(run, 2, fp("s2"), 6710)));
  add("register (stage 3)", await used(registry.register(run, 3, fp("s3"), 6844)));

  // Sensitivity to run id length (the id is hashed and emitted in the event, not stored)
  const longRun = "nba-baseline-experiment-2026-11-04-seed-42-final-candidate"; // 58 characters
  add("register (58-char run id)", await used(registry.register(longRun, 1, fp("L1"), 6600)),
    "longer id costs a little more in calldata and event data");

  // Rejected writes (gas is still spent)
  add("register rejected: duplicate record",
    await revertedGas(registry, registrar, [run, 1, fp("s1"), 6523]), "gas still charged on revert");
  add("register rejected: not the registrar",
    await revertedGas(registry, outsider, ["run-x", 1, fp("x"), 5000]), "gas still charged on revert");

  // Reads. Called off-chain (eth_call) they cost the caller nothing. estimateGas shows
  // what the same call would cost if sent as a transaction; that figure includes the
  // 21,000 gas base cost every transaction pays.
  const readEstimate = async (fn, args) => Number(await registry[fn].estimateGas(...args));
  const readNote = "as a transaction, includes 21,000 base; off-chain eth_call is free";
  add("getRecord (read, existing record)", await readEstimate("getRecord", [run, 1]), readNote);
  add("getRecord (read, no record)", await readEstimate("getRecord", ["missing-run", 1]), readNote);
  add("isRegistered (read)", await readEstimate("isRegistered", [run, 1]), readNote);

  // Cost of a full 3-stage run
  const fresh = await Factory.deploy(registrar.address);
  await fresh.waitForDeployment();
  let total = 0;
  for (const [i, acc] of [[1, 6000], [2, 6400], [3, 6700]]) {
    total += await used(fresh.register("nba-run-008", i, fp(`f${i}`), acc));
  }
  add("Register all 3 stages of one run (total)", total, "stage 1 here pays the first-write counter cost");

  // Output
  const outDir = path.join(__dirname, "..");
  fs.writeFileSync(path.join(outDir, "gas-report.json"), JSON.stringify(results, null, 2) + "\n");

  const lines = [
    "# Gas report",
    "",
    "Measured on Hardhat's in-process local chain, Solidity 0.8.24, optimizer on (200 runs).",
    "",
    "| Operation | Gas used | Note |",
    "| --- | ---: | --- |",
    ...results.map((r) => `| ${r.operation} | ${r.gas.toLocaleString("en-US")} | ${r.note} |`),
    "",
  ];
  fs.writeFileSync(path.join(outDir, "gas-report.md"), lines.join("\n"));

  console.table(results.map((r) => ({ Operation: r.operation, Gas: r.gas })));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
