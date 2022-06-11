import { ethers, network } from "hardhat";
import { Signer } from "ethers";
import { expect } from "chai";
import { shouldThrow } from "./helpers";
import { DEPLOYED_CONTRACTS } from '../scripts/deploys/helpers';
import addresses from "./constants";
import { IERC20__factory, TempleCoreStaxZaps, TempleCoreStaxZaps__factory, VaultProxy, VaultProxy__factory } from "../typechain";

const { WETH, USDC, UNI, FRAX, ETH, OGT } = addresses.tokens;
const { BINANCE_ACCOUNT_8, WETH_WHALE, FRAX_WHALE } = addresses.accounts;
const { ZEROEX_EXCHANGE_PROXY } = addresses.contracts;
const { MULTISIG, TEMPLE, TEMPLE_V2_ROUTER, FAITH, STAKING } = DEPLOYED_CONTRACTS.mainnet;

describe("Temple Stax Core Zaps", async () => {
  let templeZaps: TempleCoreStaxZaps;
  let vaultProxy: VaultProxy;
  let owner: Signer;
  let alice: Signer;
  let binanceSigner: Signer;
  let wethSigner: Signer;
  let fraxSigner: Signer;
  let ownerAddress: string;
  let aliceAddress: string;

  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.MAINNET_RPC_URL,
            blockNumber: Number(process.env.FORK_BLOCK_NUMBER),
          },
        },
      ],
    });
  });

  beforeEach(async () => {
    [owner, alice] = await ethers.getSigners();

    binanceSigner = await impersonateAddress(BINANCE_ACCOUNT_8);
    wethSigner = await impersonateAddress(WETH_WHALE);
    fraxSigner = await impersonateAddress(FRAX_WHALE);

    ownerAddress = await owner.getAddress();
    aliceAddress = await alice.getAddress();

    vaultProxy = await new VaultProxy__factory(owner).deploy(OGT, TEMPLE, STAKING, FAITH);
    templeZaps = await new TempleCoreStaxZaps__factory(owner).deploy(
      TEMPLE,
      FAITH,
      TEMPLE_V2_ROUTER,
      vaultProxy.address
    );
    await templeZaps.setApprovedTargets([ZEROEX_EXCHANGE_PROXY, TEMPLE_V2_ROUTER], [true, true]);
    await templeZaps.setPermittableTokens([USDC, UNI], [true, true]);
  });

  describe("Admin", async () => {
    it("admin tests", async () => {
      await shouldThrow(templeZaps.connect(alice).setApprovedTargets([ZEROEX_EXCHANGE_PROXY, TEMPLE_V2_ROUTER], [true, true]), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).toggleFaithClaimEnabled(), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).toggleContractActive(), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).setTempleRouter(TEMPLE_V2_ROUTER), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).setPermittableTokens([FRAX], [true]), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).setSupportedStables([FRAX], [true]), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).recoverToken(FRAX, await alice.getAddress(), 100), /Ownable: caller is not the owner/);

      // happy paths
      await templeZaps.setApprovedTargets([ZEROEX_EXCHANGE_PROXY, TEMPLE_V2_ROUTER], [true, true]);
      await templeZaps.toggleContractActive();
      await templeZaps.toggleFaithClaimEnabled();
      await templeZaps.setTempleRouter(TEMPLE_V2_ROUTER);
      await templeZaps.setPermittableTokens([FRAX], [true]);
      await templeZaps.setSupportedStables([FRAX], [true]);
    });

    it("sets approved targets", async () => {
      await templeZaps.setApprovedTargets([ZEROEX_EXCHANGE_PROXY, TEMPLE_V2_ROUTER], [true, false]);
      expect(await templeZaps.approvedTargets(ZEROEX_EXCHANGE_PROXY)).to.eq(true);
      expect(await templeZaps.approvedTargets(TEMPLE_V2_ROUTER)).to.eq(false);
    });

    it("toggles faith claim", async () => {
      const currentState = await templeZaps.faithClaimEnabled();
      await templeZaps.toggleFaithClaimEnabled();
      expect(await templeZaps.faithClaimEnabled()).to.eq(!currentState);
    });

    it("toggles contract active", async () => {
      const currentState = await templeZaps.paused();
      await templeZaps.toggleContractActive();
      expect(await templeZaps.paused()).to.eq(!currentState);
    });

    it("sets temple router", async () => {
      await templeZaps.setTempleRouter(TEMPLE_V2_ROUTER);
      expect(await templeZaps.templeRouter()).to.eq(TEMPLE_V2_ROUTER);
    });

    it("sets supported stables", async () => {
      await templeZaps.setSupportedStables([USDC, FRAX], [true, false]);
      expect(await templeZaps.supportedStables(USDC)).to.eq(true);
      expect(await templeZaps.supportedStables(FRAX)).to.eq(false);
    });

    it("sets permittable tokens", async () => {
      await templeZaps.setPermittableTokens([UNI, FRAX], [true, false]);
      expect(await templeZaps.permittableTokens(UNI)).to.eq(true);
      expect(await templeZaps.permittableTokens(FRAX)).to.eq(false);
    });

    it("recovers token", async () => {
      // transfer frax to zaps contract
      const frax = IERC20__factory.connect(FRAX, fraxSigner);
      await frax.transfer(templeZaps.address, 1000);
            
      // recover
      await expect(templeZaps.recoverToken(FRAX, await owner.getAddress(), 1000))
          .to.emit(templeZaps, "TokenRecovered")
          .withArgs(await owner.getAddress(), 1000);
      
      expect(await frax.balanceOf(await owner.getAddress())).eq(1000);
    });
  });

  
});

async function impersonateAddress(address: string) {
  await network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [address],
  });
  return ethers.provider.getSigner(address);
}

async function resetFork() {
  await network.provider.request({
    method: 'hardhat_reset',
    params: [
      {
        forking: {
          jsonRpcUrl: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_API_KEY}`,
        },
      },
    ],
  });
}