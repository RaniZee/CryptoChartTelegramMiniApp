import asyncio
import os
import json 

import ccxt.async_support as ccxt
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from contextlib import asynccontextmanager

from dotenv import load_dotenv 

from aiogram import Bot, Dispatcher, types, F 
from aiogram.filters import CommandStart
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

load_dotenv() 
BOT_TOKEN = os.getenv("BOT_TOKEN")

bot: Optional[Bot] = None
dp: Optional[Dispatcher] = None

if not BOT_TOKEN:
    print("Error: BOT_TOKEN not found in .env or environment variables! Telegram Bot will not be started.")
else:
    try:
        default_bot_properties = DefaultBotProperties(
            parse_mode=ParseMode.HTML
        )
        bot = Bot(token=BOT_TOKEN, default=default_bot_properties)
        dp = Dispatcher()
        print("Telegram Bot and Dispatcher initialized successfully.")
    except Exception as e:
        print(f"Error initializing Telegram Bot: {e}. Bot will not be started.")
        bot = None
        dp = None

class Kline(BaseModel):
    timestamp: int
    open: float
    high: float
    low: float
    close: float
    volume: float

@asynccontextmanager
async def lifespan(app_fastapi: FastAPI):
    print("FastAPI application startup (via lifespan)...")
    if bot and dp:
        print("Creating task for bot polling...")
        asyncio.create_task(run_bot_polling()) 
    else:
        print("Skipping bot startup due to missing BOT_TOKEN or uninitialized Bot/Dispatcher.")
    
    yield

    print("FastAPI application shutdown (via lifespan)...")
    if bot and bot.session:
        print("Closing bot session...")
        await bot.session.close()
        print("Bot session closed.")

app = FastAPI(
    title="Crypto Chart MiniApp API",
    description="API для получения данных о криптовалютах для Telegram MiniApp",
    version="0.1.2",
    lifespan=lifespan
)

origins = [
    "http://localhost",
    "http://localhost:5500", 
    "http://127.0.0.1:5500",
    "https://ranizee.github.io", 
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPPORTED_EXCHANGES = {
    "kucoin": "KuCoin",
    "gateio": "Gate.io",
    "okx": "OKX",
    "kraken": "Kraken",
    "htx": "HTX (Huobi)", 
    "bitget": "Bitget",
    "mexc": "MEXC Global",
}

@app.get("/")
async def root():
    return {"message": "Crypto Chart API is running!"}

@app.get("/exchanges", response_model=Dict[str, str])
async def get_exchanges_endpoint(): 
    return SUPPORTED_EXCHANGES

@app.get("/symbols", response_model=List[str])
async def get_symbols_endpoint( 
    exchange_id: str = Query(..., description="ID биржи из CCXT (например, 'kucoin')")
):
    if exchange_id not in SUPPORTED_EXCHANGES and not hasattr(ccxt, exchange_id):
        raise HTTPException(status_code=404, detail=f"Exchange ID '{exchange_id}' is not supported or not found.")
    
    try:
        exchange_class = getattr(ccxt, exchange_id)
    except AttributeError:
        raise HTTPException(status_code=404, detail=f"Exchange ID '{exchange_id}' not found in CCXT library.")
        
    exchange = exchange_class()
    active_symbols = []
    try:
        await exchange.load_markets() 
        if exchange.markets:
            symbols_from_exchange = list(exchange.markets.keys())
            active_symbols = [
                s for s in symbols_from_exchange 
                if s.endswith(('/USDT', '/USD', '/BTC', '/ETH', '/EUR')) and 
                   ':' not in s and 
                   'SWAP' not in s.upper() and 
                   'PERP' not in s.upper() and
                   'FUTURE' not in s.upper()
            ]
            active_symbols.sort()
        return active_symbols if active_symbols else ["Нет подходящих пар на бирже"]
    except ccxt.NetworkError as e:
        print(f"NetworkError on /symbols for {exchange_id}: {e}")
        raise HTTPException(status_code=503, detail=f"Network error connecting to {exchange_id}: {str(e)}")
    except ccxt.ExchangeNotAvailable as e:
        print(f"ExchangeNotAvailable on /symbols for {exchange_id}: {e}")
        return [f"Биржа {exchange_id} временно недоступна"] 
    except ccxt.ExchangeError as e:
        print(f"ExchangeError on /symbols for {exchange_id}: {e}")
        return [f"Ошибка при загрузке пар с биржи {exchange_id}"] 
    except Exception as e:
        print(f"Unexpected error on /symbols for {exchange_id}: {e}")
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred with {exchange_id} while fetching symbols: {str(e)}")
    finally:
        if hasattr(exchange, 'close'):
            await exchange.close()

@app.get("/klines", response_model=List[Kline])
async def get_klines_endpoint( 
    exchange_id: str = Query(..., description="ID биржи"),
    symbol: str = Query(..., description="Торговая пара (например, BTC/USDT)"),
    timeframe: str = Query(..., description="Таймфрейм (1m, 5m, 1h, 1d)"),
    limit: Optional[int] = Query(None, description="Количество свечей, если 'since' не указан или для ограничения после 'since'", ge=1, le=2000),
    since: Optional[int] = Query(None, description="Timestamp начала периода в миллисекундах (UTC)"),
):
    if exchange_id not in SUPPORTED_EXCHANGES and not hasattr(ccxt, exchange_id):
        raise HTTPException(status_code=404, detail=f"Exchange ID '{exchange_id}' is not supported or not found.")

    try:
        exchange_class = getattr(ccxt, exchange_id)
    except AttributeError:
        raise HTTPException(status_code=404, detail=f"Exchange ID '{exchange_id}' not found in CCXT library.")

    exchange = exchange_class({'enableRateLimit': True})
    fetch_params = {}
    if since is not None:
        fetch_params['since'] = since
        fetch_params['limit'] = limit if limit is not None else 1500 
    elif limit is not None:
        fetch_params['limit'] = limit
    else:
        fetch_params['limit'] = 200

    try:
        try:
            if not exchange.markets: 
                await exchange.load_markets()
        except Exception as e_markets:
            print(f"Warning: Could not load_markets for {exchange_id} during klines fetch (continuing anyway): {e_markets}")

        if hasattr(exchange, 'timeframes') and exchange.timeframes and timeframe not in exchange.timeframes:
            available_tfs = list(exchange.timeframes.keys())
            raise HTTPException(status_code=400, detail=f"Timeframe '{timeframe}' not supported by {exchange_id}. Available: {available_tfs}")
        
        print(f"Fetching OHLCV for {exchange_id}, {symbol}, {timeframe} with params: {fetch_params}")
        ohlcv = await exchange.fetch_ohlcv(symbol, timeframe, **fetch_params)
        klines_data = []
        for kline_item in ohlcv:
            if len(kline_item) >= 6:
                klines_data.append(Kline(
                    timestamp=kline_item[0], open=kline_item[1], high=kline_item[2], 
                    low=kline_item[3], close=kline_item[4], volume=kline_item[5]
                ))
            else:
                print(f"Warning: Incomplete kline data for {symbol} at {kline_item[0] if kline_item else 'unknown timestamp'}: {kline_item}")
        print(f"Returning {len(klines_data)} klines for {symbol} from {exchange_id}")
        return klines_data
        
    except ccxt.NetworkError as e:
        print(f"NetworkError for {exchange_id} {symbol} {timeframe}: {e}")
        raise HTTPException(status_code=503, detail=f"Network error: {str(e)}")
    except ccxt.BadSymbol as e:
        print(f"BadSymbol for {exchange_id} {symbol} {timeframe}: {e}")
        raise HTTPException(status_code=404, detail=f"Symbol '{symbol}' not found or invalid on {exchange_id}. Details: {str(e)}")
    except ccxt.ExchangeError as e:
        print(f"ExchangeError for {exchange_id} {symbol} {timeframe}: {e}")
        raise HTTPException(status_code=502, detail=f"Exchange error from {exchange_id}: {str(e)}")
    except Exception as e:
        print(f"Unexpected error for {exchange_id} {symbol} {timeframe}: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")
    finally:
        if hasattr(exchange, 'close'):
            await exchange.close()

if dp and bot: 
    @dp.message(CommandStart())
    async def send_welcome(message: types.Message):
        await message.reply(
            f"Привет, {message.from_user.full_name}!\n"
            "Нажми кнопку меню ☰ (или /) внизу слева, чтобы открыть график криптовалют.",
        )

    @dp.message(F.web_app_data) 
    async def handle_web_app_data(message: types.Message):
        user_id = message.from_user.id
        print(f"Received WebApp data from user {user_id}: {message.web_app_data.data}")
        try:
            await message.answer(f"Спасибо! Получил от MiniApp: <code>{message.web_app_data.data}</code>")
        except json.JSONDecodeError:
            await message.answer("Ошибка: не смог разобрать данные от WebApp.")
        except Exception as e:
            await message.answer(f"Произошла ошибка при обработке данных от WebApp: {e}")

async def run_bot_polling():
    if dp and bot:
        print("Starting Telegram Bot polling...")
        await dp.start_polling(bot) 
    else:
        print("Telegram Bot polling will not start (BOT_TOKEN missing or Dispatcher/Bot not initialized).")