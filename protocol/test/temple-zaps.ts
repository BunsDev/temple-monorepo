import { ethers, network } from "hardhat";
import { Signer, BigNumber } from "ethers";
import { expect } from "chai";
import axios from 'axios';
import { shouldThrow } from "./helpers";
import { DEPLOYED_CONTRACTS } from '../scripts/deploys/helpers';
import addresses from "./constants";
import { IERC20, IERC20__factory, TempleCoreStaxZaps, TempleCoreStaxZaps__factory, TempleStableAMMRouter__factory, VaultProxy, VaultProxy__factory } from "../typechain";

const { WETH, USDC, UNI, FRAX, ETH, OGT, FEI, BNB } = addresses.tokens;
const { BINANCE_ACCOUNT_8, WETH_WHALE, FRAX_WHALE } = addresses.accounts;
const { ZEROEX_EXCHANGE_PROXY, TEMPLE_STABLE_ROUTER } = addresses.contracts;
const { MULTISIG, TEMPLE, TEMPLE_V2_ROUTER, FAITH, STAKING } = DEPLOYED_CONTRACTS.mainnet;

const ZEROEX_QUOTE_ENDPOINT = 'https://api.0x.org/swap/v1/quote?';

let templeZaps: TempleCoreStaxZaps;
let vaultProxy: VaultProxy;
let owner: Signer;
let alice: Signer;
let binanceSigner: Signer;
let wethSigner: Signer;
let fraxSigner: Signer;
let ownerAddress: string;
let aliceAddress: string;

describe("Temple Stax Core Zaps", async () => {

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
    await templeZaps.setTempleRouter(TEMPLE_STABLE_ROUTER);
    await templeZaps.setSupportedStables([FRAX, FEI], [true, true]);
  });

  describe("Admin", async () => {
    it("admin tests", async () => {
      await shouldThrow(templeZaps.connect(alice).setApprovedTargets([ZEROEX_EXCHANGE_PROXY, TEMPLE_STABLE_ROUTER], [true, true]), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).toggleFaithClaimEnabled(), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).toggleContractActive(), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).setTempleRouter(TEMPLE_STABLE_ROUTER), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).setPermittableTokens([FRAX], [true]), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).setSupportedStables([FRAX], [true]), /Ownable: caller is not the owner/);
      await shouldThrow(templeZaps.connect(alice).recoverToken(FRAX, await alice.getAddress(), 100), /Ownable: caller is not the owner/);

      // happy paths
      await templeZaps.setApprovedTargets([ZEROEX_EXCHANGE_PROXY, TEMPLE_STABLE_ROUTER], [true, true]);
      await templeZaps.toggleContractActive();
      await templeZaps.toggleFaithClaimEnabled();
      await templeZaps.setTempleRouter(TEMPLE_STABLE_ROUTER);
      await templeZaps.setPermittableTokens([FRAX], [true]);
      await templeZaps.setSupportedStables([FRAX], [true]);
    });

    it("sets approved targets", async () => {
      await templeZaps.setApprovedTargets([ZEROEX_EXCHANGE_PROXY, TEMPLE_STABLE_ROUTER], [true, false]);
      expect(await templeZaps.approvedTargets(ZEROEX_EXCHANGE_PROXY)).to.eq(true);
      expect(await templeZaps.approvedTargets(TEMPLE_STABLE_ROUTER)).to.eq(false);
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
      await templeZaps.setTempleRouter(TEMPLE_STABLE_ROUTER);
      expect(await templeZaps.templeRouter()).to.eq(TEMPLE_STABLE_ROUTER);
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

  describe.only("Temple Zaps", async () => {
    afterEach(async () => {
      //await resetFork();
    });

    it("should zap ETH to TEMPLE", async () => {
      const tokenAddr = ETH;
      console.log(tokenAddr);
      const tokenAmount = "5";
      const minTempleReceived = ethers.utils.parseUnits("1", 18).toString();

      await zapIn(
        alice,
        templeZaps,
        tokenAddr,
        tokenAmount,
        minTempleReceived
      );
    });

    it("should zap ERC20 tokens to TEMPLE", async () => {
      const tokenAddr = BNB;
      const tokenAmount = "5";
      const minTempleReceived = ethers.utils.parseUnits("1", 18).toString();

      // send some BNB
      const bnbWhale = await impersonateAddress(BINANCE_ACCOUNT_8);
      const bnbToken = IERC20__factory.connect(tokenAddr, bnbWhale);
      await bnbToken.transfer(await alice.getAddress(), ethers.utils.parseEther(tokenAmount));

      await zapIn(
        alice,
        templeZaps,
        tokenAddr,
        tokenAmount,
        minTempleReceived
      );
    });
  });

  describe("Core Zaps", async () => {
    it("should zap ERC20 tokens to Temple and deposit in vault", async () => {

    });
  });
  
});

async function zapIn(
  signer: Signer,
  zaps: TempleCoreStaxZaps,
  tokenAddr: string,
  tokenAmount: string,
  minTempleReceived: string
) {
  //const tokenContract = new ethers.Contract(tokenAddr, FakeERC20.abi, signer);
  const tokenContract = IERC20__factory.connect(tokenAddr, signer);
  const templeToken = IERC20__factory.connect(TEMPLE, signer);
  const templeRouter = TempleStableAMMRouter__factory.connect(TEMPLE_STABLE_ROUTER, signer);
  let symbol;
  let decimals;
  let sellToken;
  if (tokenAddr === ETH) {
    symbol = 'ETH';
    decimals = 18;
    sellToken = 'ETH';
  } else {
    symbol = await tokenContract.symbol();
    decimals = await tokenContract.decimals();
    sellToken = tokenAddr;
  }

  // Get TEMPLE balance before zap
  const signerAddress = await signer.getAddress();
  const balanceBefore = await getBalance(templeToken, signerAddress);
  console.log(
    `Starting Temple: ${ethers.utils.formatUnits(balanceBefore, 18)}`
  );
  console.log(`Selling ${tokenAmount} ${symbol}`);

  // Approve token
  if (tokenAddr !== ETH) {
    await tokenContract.approve(
      zaps.address,
      ethers.utils.parseUnits('1000111', decimals)
    );
    const allowance = await tokenContract.allowance(
      signerAddress,
      zaps.address
    );
    console.log(`Allowance: ${ethers.utils.formatUnits(allowance, decimals)}`);
  }

  // Get quote from 0x API
  let swapCallData, price, guaranteedPrice, gas, estimatedGas;
  const sellAmount = ethers.utils.parseUnits(tokenAmount, decimals).toString();

  if (tokenAddr === FRAX) {
    guaranteedPrice = '0.99';
    swapCallData = '0x';
  } else {
    const url = `${ZEROEX_QUOTE_ENDPOINT}sellToken=${sellToken}&sellAmount=${sellAmount}&buyToken=${FRAX}`;
    const response = await axios.get(url);
    ({
      data: { data: swapCallData, price, guaranteedPrice, gas, estimatedGas },
    } = response);

    console.log(`Price of ${symbol} in FRAX: ${price}`);
    console.log(`Guaranteed price: ${guaranteedPrice}`);
  }
  // fei pair 0xf994158766e0a4E64c26feCE675186f489EC9107
  // frax pair 0x6021444f1706f15465bEe85463BCc7d7cC17Fc03
  const fraxPair = '0x6021444f1706f15465bEe85463BCc7d7cC17Fc03';
  // Do zap
  //console.log(templeRouter.address);
  //const pair = await templeRouter.tokenPair(FRAX);
  //console.log("parir", pair)
  const minExpectedTemple = await getExpectedTemple(
    signer,
    guaranteedPrice,
    tokenAmount,
    fraxPair
  );
  console.log(`1st Min Expected Temple ${minExpectedTemple}`);

  const zapsConnect = zaps.connect(signer);
  const overrides: { value?: BigNumber } = {};
  if (tokenAddr === ETH) {
    overrides.value = ethers.utils.parseEther(tokenAmount);
  }

  await zapsConnect.zapIn(
    tokenAddr,
    sellAmount,
    minTempleReceived,
    FRAX,
    //Math.floor(Date.now() / 1000) + 1200, // deadline of 20 minutes from now
    ZEROEX_EXCHANGE_PROXY,
    swapCallData,
    overrides
  );

  console.log(
    `Minimum expected Temple: ${ethers.utils.formatUnits(
      minExpectedTemple,
      18
    )}`
  );
  // Get Temple balance after zap
  const balanceAfter = await getBalance(templeToken, signerAddress);
  console.log(`Ending Temple: ${ethers.utils.formatUnits(balanceAfter, 18)}`);

  expect(balanceAfter.gte(minExpectedTemple)).to.be.true;
  //expect(balanceAfter).to.eq(minExpectedTemple.add(balanceBefore));
  //await expectZappedInEvent(signerAddress, balanceBefore, balanceAfter);
}

async function expectZappedInEvent(
  signerAddress: string,
  balanceBefore: BigNumber,
  balanceAfter: BigNumber
) {
  const zappedInEvent = await templeZaps.queryFilter(
    templeZaps.filters.ZappedIn()
  );
  const event = zappedInEvent[0];
  console.log(`event ${JSON.stringify(event)}`);
  expect(event.args.sender).to.equal(signerAddress);
  expect(event.args.amountReceived).to.equal(balanceAfter.sub(balanceBefore));
}

async function impersonateAddress(address: string) {
  await network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [address],
  });
  return ethers.provider.getSigner(address);
}

async function getExpectedTemple(
  signer: Signer,
  guaranteedPrice: string,
  tokenAmount: string,
  pair: string
): Promise<BigNumber> {
  /*const ammContract = new ethers.Contract(
    TEMPLE_STABLE_ROUTER,
    TempleStableAMMRouter__factory.abi,
    signer
  );*/
  const ammContract = TempleStableAMMRouter__factory.connect(TEMPLE_STABLE_ROUTER, signer);
  const minFraxReceived = parseFloat(guaranteedPrice) * parseFloat(tokenAmount);
  const minFraxReceivedWei = ethers.utils.parseUnits(
    minFraxReceived.toString(),
    18
  );
  console.log(`Min Frax Received in Wei ${minFraxReceivedWei}`);
  /*const quote = await ammContract.swapExactFraxForTempleQuote(
    minFraxReceivedWei
  );*/
  const quote = await ammContract.swapExactStableForTempleQuote(pair, minFraxReceivedWei);
  return quote;
}

async function getBalance(token: IERC20, owner: string) {
  return await token.balanceOf(owner);
};

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