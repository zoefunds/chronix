#!/usr/bin/env node
/**
 * Deploys ChronixEscrow.sol to Base Sepolia.
 *
 * Reads everything from environment variables — NEVER pass a private key
 * as a CLI argument or paste one into chat/logs. Put it in a local .env
 * (gitignored) or your shell's secret-loaded env, then run:
 *
 *   DEPLOYER_PRIVATE_KEY=... \
 *   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
 *   BASE_SEPOLIA_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
 *   RELAYER_ADDRESS=0x... \
 *   node contracts/base/deploy.js
 *
 * Requires: npm i -D ethers solc  (in whichever package.json runs this from)
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function compile() {
  const sourcePath = path.join(__dirname, "ChronixEscrow.sol");
  const source = fs.readFileSync(sourcePath, "utf8");
  const input = {
    language: "Solidity",
    sources: { "ChronixEscrow.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    errors.forEach((e) => console.error(e.formattedMessage));
    process.exit(1);
  }
  const contract = output.contracts["ChronixEscrow.sol"]["ChronixEscrow"];
  return { abi: contract.abi, bytecode: contract.evm.bytecode.object };
}

async function main() {
  const privateKey = requireEnv("DEPLOYER_PRIVATE_KEY");
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  const usdcAddress =
    process.env.BASE_SEPOLIA_USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const relayerAddress = requireEnv("RELAYER_ADDRESS");

  const { abi, bytecode } = compile();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`Deploying from ${wallet.address} to ${rpcUrl} ...`);

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(usdcAddress, relayerAddress);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("ChronixEscrow deployed at:", address);
  console.log("\nSet these in backend/.env:");
  console.log(`CHRONIX_ESCROW_ADDRESS=${address}`);
  console.log(`BASE_SEPOLIA_USDC_ADDRESS=${usdcAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
