// Deploys ModelRegistry to a running local node and exports what Python needs.
// Usage (node must be running):  npx hardhat run scripts/deploy.js --network localhost
//
// The deploying account (Hardhat account #0) becomes the designated registrar.
// Outputs:
//   abi/ModelRegistry.json        the contract interface (tracked in Git)
//   deployment/deployment.json    address, registrar, chain id (local chain state, git-ignored)

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [registrar] = await hre.ethers.getSigners();
  const Factory = await hre.ethers.getContractFactory("ModelRegistry");
  const registry = await Factory.deploy(registrar.address);
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  const { chainId } = await hre.ethers.provider.getNetwork();
  const root = path.join(__dirname, "..");

  // ABI: stable file that Python reads. Same output every time, so Git sees no noise.
  fs.mkdirSync(path.join(root, "abi"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "abi", "ModelRegistry.json"),
    JSON.stringify(JSON.parse(registry.interface.formatJson()), null, 2) + "\n"
  );

  // Address: changes with every fresh chain, so it is local state and is not committed.
  fs.mkdirSync(path.join(root, "deployment"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "deployment", "deployment.json"),
    JSON.stringify(
      {
        contract: "ModelRegistry",
        address,
        registrar: registrar.address,
        chainId: Number(chainId),
        rpcUrl: "http://127.0.0.1:8545",
        network: hre.network.name,
      },
      null,
      2
    ) + "\n"
  );

  console.log(`ModelRegistry deployed to ${address}`);
  console.log(`Designated registrar:    ${registrar.address}`);
  console.log("Wrote abi/ModelRegistry.json and deployment/deployment.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
