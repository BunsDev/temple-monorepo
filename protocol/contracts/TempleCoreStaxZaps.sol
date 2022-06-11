pragma solidity ^0.8.4;
// SPDX-License-Identifier: AGPL-3.0-or-later

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ZapBaseV2_3.sol";

interface IFaith {
  // User Faith total and usable balance
  struct FaithBalance {
    uint112 lifeTimeFaith;
    uint112 usableFaith;
  } 

  function balances(address user) external view returns (FaithBalance memory);
  function gain(address to, uint112 amount) external;
  function redeem(address to, uint112 amount) external;
}

interface ILockedOGTemple {
  function OG_TEMPLE() external ;
  function withdrawFor(address _staker, uint256 _idx) external; 
}

interface ITempleStableRouter {
  function tokenPair(address token) external view returns (address);
  function swapExactStableForTemple(
    uint amountIn,
    uint amountOutMin,
    address stable,
    address to,
    uint deadline
  ) external returns (uint amountOut);
  function swapExactTempleForStable(
    uint amountIn,
    uint amountOutMin,
    address stable,
    address to,
    uint deadline
  ) external returns (uint);
  function addLiquidity(
    uint amountADesired,
    uint amountBDesired,
    uint amountAMin,
    uint amountBMin,
    address stable,
    address to,
    uint deadline
  ) external returns (uint amountA, uint amountB, uint liquidity);
  function swapExactStableForTempleQuote(address pair, uint amountIn) external view returns (uint amountOut);
  function swapExactTempleForStableQuote(address pair, uint amountIn) external view returns (bool priceBelowIV, uint amountOut);
  function quote(uint amountA, uint reserveA, uint reserveB) external pure returns (uint amountB);
}

interface IVaultProxy {
  function getFaithMultiplier(uint256 _amountFaith, uint256 _amountTemple) pure external returns (uint256);
}

interface IVault {
  function depositFor(address _account, uint256 _amount) external; 
}

interface IUniswapV2Pair {
  function token0() external view returns (address);
  function token1() external view returns (address);
  function getReserves() external view returns (uint112, uint112, uint32);
}

/*interface IWETH {
  function deposit() external payable;
}*/

contract TempleCoreStaxZaps is ZapBaseV2_3 {

  bool public faithClaimEnabled;
  
  address public constant FRAX = 0x853d955aCEf822Db058eb8505911ED77F175b99e;
  //address public constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  //address public constant TEMPLE = 0x470EBf5f030Ed85Fc1ed4C2d36B9DD02e77CF1b7;
  //address public constant OGTemple = 0x654590F810f01B51dc7B86915D4632977e49EA33;
  address public ogTemple;
  address public immutable temple;
  IFaith public faith; //0x78F683247cb2121B4eBfbD04110760da42752a6B
  //ILockedOGTemple public lockedOgTemple; // 0x879B843868dA248B1F2F53b4f8CC6e17e7E8b949
  ITempleStableRouter public templeRouter;
  IVaultProxy public vaultProxy;

  uint256 private constant DEADLINE = 0xf000000000000000000000000000000000000000000000000000000000000000;

  mapping(address => bool) public permittableTokens;
  mapping(address => bool) public supportedStables;

  // Emitted when `sender` Zaps In
  event ZappedIn(address indexed sender, uint256 amountReceived);
  event TempleRouterSet(address router);
  event ZappedInLP(address indexed sender, uint256 amountA, uint256 amountB, uint256 liquidity);
  event ZappedTemplePlusFaithInVault(address indexed sender, uint112 faithAmount, uint256 boostedAmount);
  event TokenRecovered(address to, uint256 amount);

  constructor(
    address _temple,
    address _faith,
    address _templeRouter,
    address _vaultProxy
  ) {
    temple = _temple;
    templeRouter = ITempleStableRouter(_templeRouter);
    faith = IFaith(_faith);
    vaultProxy = IVaultProxy(_vaultProxy);

    faithClaimEnabled = true;
  }

  /**
    * Toggle whether faith is claimable
    */
  function toggleFaithClaimEnabled() external onlyOwner {
    faithClaimEnabled = !faithClaimEnabled;
  }

  function setTempleRouter(address _router) external onlyOwner {
    templeRouter = ITempleStableRouter(_router);

    emit TempleRouterSet(_router);
  }

  function setPermittableTokens(
    address[] calldata _tokens,
    bool[] calldata _isPermittable
  ) external onlyOwner {
    uint256 _length = _isPermittable.length;
    require(_tokens.length == _length, 'Invalid Input length');

    for (uint256 i = 0; i < _length; i++) {
      permittableTokens[_tokens[i]] = _isPermittable[i];
    }
  }

  function setSupportedStables(
    address[] calldata _stables,
    bool[] calldata _supported
  ) external onlyOwner {
    uint _length = _stables.length;
    require(_supported.length == _length, "Invalid length");
    for (uint i=0; i<_length; i++) {
      supportedStables[_stables[i]] = _supported[i];
    }
  }

  /**
   * @notice This function zaps ETH and ERC20 tokens to Temple token
   * @param fromToken The token used for entry (address(0) if ether)
   * @param fromAmount The amount of fromToken to zap
   * @param minTempleReceived The minimum acceptable quantity of TEMPLE to receive
   * @param swapTarget Execution target for the swap
   * @param swapData DEX data
   * @return amountTemple Quantity of Temple received
   */
  function zapIn(
    address fromToken,
    uint256 fromAmount,
    uint256 minTempleReceived,
    address stableToken,
    address swapTarget,
    bytes calldata swapData
  ) external payable whenNotPaused returns (uint256 amountTemple) {
    amountTemple = _zapIn(
      fromToken,
      fromAmount,
      minTempleReceived,
      DEADLINE,
      stableToken,
      msg.sender,
      swapTarget,
      swapData
    );
  }

  function _zapIn(
    address fromToken,
    uint256 fromAmount,
    uint256 minTempleReceived,
    uint256 ammDeadline,
    address _stableToken,
    address templeReceiver,
    address swapTarget,
    bytes calldata swapData
  ) internal returns (uint256 amountTemple) {
    require(supportedStables[_stableToken], "Unsupported stable token");

    _pullTokens(fromToken, fromAmount);

    uint256 stableAmountBought = _fillQuote(
      fromToken,
      fromAmount,
      _stableToken,
      swapTarget,
      swapData
    );

    amountTemple = _enterTemple(_stableToken, templeReceiver, stableAmountBought, minTempleReceived, ammDeadline);

    emit ZappedIn(msg.sender, amountTemple);

    return amountTemple;
  }

  /**
   * @notice This function swaps FRAX for TEMPLE
   * @param _stableToken stable token 
   * @param _amountStable The amount of FRAX to swap
   * @param _minTempleReceived The minimum acceptable quantity of TEMPLE to receive
   * @param _ammDeadline deadline after which swap will not be executed
   * @return templeAmountReceived Quantity of TEMPLE received
   */
  function _enterTemple(
    address _stableToken,
    address _templeReceiver,
    uint256 _amountStable,
    uint256 _minTempleReceived,
    uint256 _ammDeadline
  ) internal returns (uint256 templeAmountReceived) {
    _approveToken(_stableToken, address(templeRouter), _amountStable);

    templeAmountReceived = templeRouter
      .swapExactStableForTemple(
        _amountStable,
        _minTempleReceived,
        _stableToken,
        _templeReceiver,
        _ammDeadline
      );
  }

  function _fillQuote(
    address _fromToken,
    uint256 _amount,
    address _stableToken,
    address _swapTarget,
    bytes memory _swapData
  ) internal returns (uint256 amountBought) {
    if (supportedStables[_fromToken]) {
      return _amount;
    }

    /*if (_swapTarget == WETH) {
      require(
          _amount > 0 && msg.value == _amount,
          "Invalid _amount: Input ETH mismatch"
      );
      IWETH(WETH).deposit{value: _amount}();
      return _amount;
    }*/

    uint256 valueToSend;
    if (_fromToken == address(0)) {
        require(
            _amount > 0 && msg.value == _amount,
            "Invalid _amount: Input ETH mismatch"
        );
        valueToSend = _amount;
    } else {
        _approveToken(_fromToken, _swapTarget, _amount);
    }

    // use supported private AMM stable token
    uint256 initialBalance = _getBalance(_stableToken);

    require(approvedTargets[_swapTarget], "Target not Authorized");
    (bool success,) = _swapTarget.call{value: valueToSend}(_swapData);
    require(success, "Error Swapping Tokens");
    
    unchecked {
      amountBought = _getBalance(_stableToken) - initialBalance;
    }
    require(amountBought > 0, "Swapped To Invalid Token");
  }

  function zapTempleFaithInVault(
    address _vault,
    address fromToken,
    uint256 fromAmount,
    uint256 minTempleReceived,
    address stableToken,
    address swapTarget,
    bytes calldata swapData
  ) external payable whenNotPaused {
    require(faithClaimEnabled, "VaultProxy: Faith claim no longer enabled");
    // pull temple
    uint256 receivedTempleAmount;
    if (fromToken == temple) {
      _pullTokens(temple, fromAmount);
      receivedTempleAmount = fromAmount;
    } else {
      receivedTempleAmount = _zapIn(
        fromToken,
        fromAmount,
        minTempleReceived,
        DEADLINE,
        stableToken,
        address(this),
        swapTarget,
        swapData
      );
    }
    
    // using user's total available faith
    uint112 faithAmount = (faith.balances(msg.sender)).usableFaith;
    faith.redeem(msg.sender, faithAmount);

    // approve boosted amount
    // note: requires this contract is prefunded to account for boost amounts, similar to vault proxy
    uint256 boostedAmount = vaultProxy.getFaithMultiplier(faithAmount, receivedTempleAmount);
    _approveToken(temple, _vault, boostedAmount);

    // deposit for user
    IVault(_vault).depositFor(msg.sender, boostedAmount);

    emit ZappedTemplePlusFaithInVault(msg.sender, faithAmount, boostedAmount);
  }

  function zapInLP(
    address _fromToken,
    uint256 _fromAmount,
    address _stableToken,
    address _swapTarget,
    bytes memory _swapData
  ) external whenNotPaused {
    require(supportedStables[_stableToken], "Unsupported stable token");
    // pull tokens
    _pullTokens(_fromToken, _fromAmount);

    _performZapInLP(
      _fromToken,
      _fromAmount,
      _stableToken,
      msg.sender,
      _swapTarget,
      _swapData
    );
  }

  function _performZapInLP(
    address _fromAddress,
    uint256 _fromAmount,
    address _stableToken,
    address _liquidityReceiver,
    address _swapTarget,
    bytes memory _swapData
  ) internal {
    address intermediateToken;
    uint256 intermediateAmount;
    // get pair tokens supporting stable coin
    address pair = templeRouter.tokenPair(_stableToken);
    address token0 = IUniswapV2Pair(pair).token0();
    address token1 = IUniswapV2Pair(pair).token1();

    if (_fromAddress != token0 && _fromAddress != token1) {
      // swap to intermediate. uses stable token
      intermediateToken = _stableToken;
      intermediateAmount = _fillQuote( // perhaps add a stableToken argument? so that it can handle both frax and fei
        _fromAddress,
        _fromAmount,
        _stableToken,
        _swapTarget,
        _swapData
      );
    } else {
        intermediateToken = _fromAddress;
        intermediateAmount = _fromAmount;
    }

    // divide intermediate into appropriate amount to add liquidity
    /*(uint256 token0Bought, uint256 token1Bought) = _swapIntermediate(
      intermediateToken,
      _ToUniswapToken0,
      _ToUniswapToken1,
      intermediateAmt,
      _uniswapRouter
    );*/
    // divide token into 2 and swap other half. making sure there's no residual tokens
    // at this point, intermediate token could be temple or frax
    /*uint256 intermediateAmountToSwap = intermediateAmount / 2;
    unchecked {
      intermediateAmount -= intermediateAmountToSwap;
    }
    uint256 amountOut;
    uint256 amountA;
    uint256 amountB;
    {
      if (intermediateToken == temple) {
      (,uint256 otherTokenAmountOutMin) = templeRouter.swapExactTempleForStableQuote(pair, intermediateAmountToSwap);
      _approveToken(temple, address(templeRouter), intermediateAmountToSwap);
      amountOut = templeRouter.swapExactTempleForStable(intermediateAmountToSwap, otherTokenAmountOutMin, _stableToken, address(this), DEADLINE); // always FRAX? when to use stableToken argument above?
      amountA = token0 == _stableToken ? amountOut : intermediateAmount;
      amountB = token0 == _stableToken ? intermediateAmount : amountOut; 
      } else if (intermediateToken == _stableToken) {
        intermediateAmountToSwap = intermediateAmount / 2;
        intermediateAmount -= intermediateAmountToSwap;
        uint256 otherTokenAmountOutMin = templeRouter.swapExactStableForTempleQuote(pair, intermediateAmountToSwap);
        _approveToken(_stableToken, address(templeRouter), intermediateAmountToSwap);
        amountOut = templeRouter.swapExactStableForTemple(intermediateAmountToSwap, otherTokenAmountOutMin, _stableToken, address(this), DEADLINE);
        amountA = token0 == _stableToken ? intermediateAmount : amountOut;
        amountB = token0 == _stableToken ? amountOut : intermediateAmount;
      } else {
        revert("Unsupported token for LP addition");
      }
    }*/

    (uint256 amountA, uint256 amountB) = _swapTokens(pair, _stableToken, intermediateToken, intermediateAmount);
    
    // add LP
    _addLiquidity(_stableToken, pair, _liquidityReceiver, amountA, amountB);
  }

  function _swapTokens(
    address _pair,
    address _stableToken,
    address _intermediateToken,
    uint256 _intermediateAmount
  ) internal returns (uint256 amountA, uint256 amountB) {
    address token0 = IUniswapV2Pair(_pair).token0();
    uint256 intermediateAmountToSwap = _intermediateAmount / 2;
    unchecked {
      _intermediateAmount -= intermediateAmountToSwap;
    }
    uint256 amountOut;
    if (_intermediateToken == temple) {
      (,uint256 otherTokenAmountOutMin) = templeRouter.swapExactTempleForStableQuote(_pair, intermediateAmountToSwap);
      _approveToken(temple, address(templeRouter), intermediateAmountToSwap);
      amountOut = templeRouter.swapExactTempleForStable(intermediateAmountToSwap, otherTokenAmountOutMin, _stableToken, address(this), DEADLINE); // always FRAX? when to use stableToken argument above?
      amountA = token0 == _stableToken ? amountOut : _intermediateAmount;
      amountB = token0 == _stableToken ? _intermediateAmount : amountOut; 
      } else if (_intermediateToken == _stableToken) {
        intermediateAmountToSwap = _intermediateAmount / 2;
        _intermediateAmount -= intermediateAmountToSwap;
        uint256 otherTokenAmountOutMin = templeRouter.swapExactStableForTempleQuote(_pair, intermediateAmountToSwap);
        _approveToken(_stableToken, address(templeRouter), intermediateAmountToSwap);
        amountOut = templeRouter.swapExactStableForTemple(intermediateAmountToSwap, otherTokenAmountOutMin, _stableToken, address(this), DEADLINE);
        amountA = token0 == _stableToken ? _intermediateAmount : amountOut;
        amountB = token0 == _stableToken ? amountOut : _intermediateAmount;
      } else {
        revert("Unsupported token for LP addition");
      }
  }

  function _addLiquidity(
    address _stableToken,
    address _pair,
    address _liquidityReceiver,
    uint256 _amountA,
    uint256 _amountB
  ) internal {
    // get minimum amounts to use in liquidity addition. use optimal amounts as minimum
    (uint256 amountAMin, uint256 amountBMin) = _addLiquidityGetMinAmounts(_amountA, _amountB, IUniswapV2Pair(_pair));
    (uint256 amountA, uint256 amountB, uint256 liquidity) = templeRouter.addLiquidity(
      _amountA,
      _amountB,
      amountAMin,
      amountBMin,
      _stableToken,
      _liquidityReceiver,
      DEADLINE
    );

    emit ZappedInLP(_liquidityReceiver, amountA, amountB, liquidity);
  }

  /**
    @dev Transfers tokens from msg.sender to this contract
    @dev If native token, use msg.value
    @dev For use with Zap Ins
    @param token The ERC20 token to transfer to this contract (0 address if ETH)
    @return Quantity of tokens transferred to this contract
     */
  function _pullTokens(
    address token,
    uint256 amount
  ) internal returns (uint256) {
    if (token == address(0)) {
      require(msg.value > 0, "No ETH sent");
      return msg.value;
    }

    require(amount > 0, "Invalid token amount");
    require(msg.value == 0, "ETH sent with token");

    SafeERC20.safeTransferFrom(
      IERC20(token),
      msg.sender,
      address(this),
      amount
    );

    return amount;
  }

  /** 
    * given some amount of an asset and pair reserves, returns an equivalent amount of the other asset
    *
    * Direct copy of UniswapV2Library.quote(amountA, reserveA, reserveB) - can't use as directly as it's built off a different version of solidity
    */
  function _quote(uint amountA, uint reserveA, uint reserveB) internal pure returns (uint amountB) {
    //require(amountA > 0, 'UniswapV2Library: INSUFFICIENT_AMOUNT');
    //require(reserveA > 0 && reserveB > 0, 'UniswapV2Library: INSUFFICIENT_LIQUIDITY');
    amountB = (amountA * reserveB) / reserveA;
  }

  function _addLiquidityGetMinAmounts(
    uint amountADesired,
    uint amountBDesired,
    IUniswapV2Pair pair
  ) internal virtual returns (uint amountA, uint amountB) {
    (uint reserveA, uint reserveB,) = pair.getReserves();
    if (reserveA == 0 && reserveB == 0) {
      (amountA, amountB) = (amountADesired, amountBDesired);
    } else {
      uint amountBOptimal = _quote(amountADesired, reserveA, reserveB);
      if (amountBOptimal <= amountBDesired) {
          //require(amountBOptimal >= amountBMin, 'TempleStableAMMRouter: INSUFFICIENT_STABLE');
          (amountA, amountB) = (amountADesired, amountBOptimal);
      } else {
          uint amountAOptimal = _quote(amountBDesired, reserveB, reserveA);
          assert(amountAOptimal <= amountADesired);
          //require(amountAOptimal >= amountAMin, 'TempleStableAMMRouter: INSUFFICIENT_TEMPLE');
          (amountA, amountB) = (amountAOptimal, amountBDesired);
      }
    }
  }

  // recover tokens
  function recoverToken(address _token, address _to, uint256 _amount) external onlyOwner {
    require(_to != address(0), "Invalid receiver");
    if (_token == address(0)) {
      // this is effectively how OpenZeppelin transfers eth
      require(address(this).balance >= _amount, "Address: insufficient balance");
      (bool success,) = _to.call{value: _amount}(""); 
      require(success, "Address: unable to send value");
    } else {
      _transferToken(IERC20(_token), _to, _amount);
    }
    
    emit TokenRecovered(_to, _amount);
  }

  function _transferToken(IERC20 _token, address _to, uint256 _amount) internal {
    uint256 balance = _token.balanceOf(address(this));
    require(_amount <= balance, "not enough tokens");
    SafeERC20.safeTransfer(_token, _to, _amount);
  }
}