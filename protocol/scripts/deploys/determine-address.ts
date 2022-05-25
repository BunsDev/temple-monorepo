import { getContractAddress } from "@ethersproject/address";
import { ethers } from "hardhat";
import {
    ensureExpectedEnvvars,
  } from "./helpers";

async function main() {
    ensureExpectedEnvvars();
    const [owner] = await ethers.getSigners();

    const txCount = await owner.getTransactionCount();

    const futureAddress = getContractAddress({
        from: owner.address,
        nonce: txCount
    });

    console.log(`Future Address for ${await owner.getAddress()} is ${futureAddress}`);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });