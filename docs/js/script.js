document.addEventListener('DOMContentLoaded', () => {
    const tg = window.Telegram.WebApp;

    const exchangeSelect = document.getElementById('exchange-select');
    const symbolSelect = document.getElementById('symbol-select');
    const symbolSearchInput = document.getElementById('symbol-search');
    const timeframeSelect = document.getElementById('timeframe-select');
    const startDatetimeInput = document.getElementById('start-datetime');
    
    const fetchChartButton = document.getElementById('fetch-chart-button');
    const chartContainer = document.getElementById('chart');
    const loadingIndicator = document.getElementById('loading-indicator');
    const errorMessageElement = document.getElementById('error-message');
    const closeButton = document.getElementById('close-button');

    let chart = null;
    let candlestickSeries = null;
    const API_BASE_URL = 'https://crypto-miniapp-backend.onrender.com';
    
    let currentChartRequestParams = null; 
    let updateIntervalId = null;
    const UPDATE_INTERVAL_MS = 30000; 

    
    if (tg && tg.ready) {
        tg.ready();
        if (tg.MainButton.isVisible) {
            tg.MainButton.hide();
        }
        tg.expand();
    }

    function applyTheme(themeParams) {
        if (!themeParams) return;
        const root = document.documentElement.style;
        root.setProperty('--tg-theme-bg-color', themeParams.bg_color || '#ffffff');
        root.setProperty('--tg-theme-text-color', themeParams.text_color || '#000000');
        root.setProperty('--tg-theme-hint-color', themeParams.hint_color || '#707579');
        root.setProperty('--tg-theme-link-color', themeParams.link_color || '#2481cc');
        root.setProperty('--tg-theme-button-color', themeParams.button_color || '#2481cc');
        root.setProperty('--tg-theme-button-text-color', themeParams.button_text_color || '#ffffff');
        root.setProperty('--tg-theme-secondary-bg-color', themeParams.secondary_bg_color || '#f0f0f0');

        if (chart) {
            chart.applyOptions({
                layout: {
                    background: { type: 'solid', color: themeParams.bg_color || '#ffffff' }, 
                    textColor: themeParams.text_color || '#000000',
                },
                grid: {
                    vertLines: { color: themeParams.secondary_bg_color || '#f0f0f0' },
                    horzLines: { color: themeParams.secondary_bg_color || '#f0f0f0' },
                },
            });
        }
    }

    if (tg && tg.themeParams) { applyTheme(tg.themeParams); }
    if (tg && tg.onEvent) { tg.onEvent('themeChanged', () => tg.themeParams && applyTheme(tg.themeParams)); }
    if (closeButton && tg && tg.close) { closeButton.addEventListener('click', () => tg.close()); }

    function showLoading(isLoading) { loadingIndicator.style.display = isLoading ? 'block' : 'none'; }
    function showError(message) {
        errorMessageElement.textContent = message;
        errorMessageElement.style.display = message ? 'block' : 'none';
        if (message) { setTimeout(() => { errorMessageElement.style.display = 'none'; }, 5000); }
    }
    function setControlsDisabled(disabled) {
        [exchangeSelect, symbolSelect, symbolSearchInput, timeframeSelect, startDatetimeInput,  fetchChartButton].forEach(el => {
            if (el) el.disabled = disabled;
        });
    }

    async function fetchApi(endpoint, errorMessagePrefix = 'Ошибка') {
        const response = await fetch(`${API_BASE_URL}${endpoint}`);
        if (!response.ok) {
            let errorDetail = `${errorMessagePrefix}: ${response.statusText} (${response.status})`;
            try {
                const errorData = await response.json();
                errorDetail = errorData.detail || errorDetail;
            } catch (e) {  }
            throw new Error(errorDetail);
        }
        return response.json();
    }

    async function fetchExchanges() {
        try {
            showLoading(true); showError('');
            const exchanges = await fetchApi('/exchanges', 'Ошибка загрузки бирж');
            populateExchangeSelect(exchanges);
        } catch (error) {
            console.error('Error fetching exchanges:', error); showError(error.message);
            exchangeSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
        } finally {
            showLoading(false);
            
            exchangeSelect.disabled = false;
            [symbolSelect, symbolSearchInput, timeframeSelect, startDatetimeInput,  fetchChartButton].forEach(el => el.disabled = true);
        }
    }

    async function fetchSymbols(exchangeId) {
        if (!exchangeId) {
            symbolSelect.innerHTML = '<option value="">Выберите биржу</option>';
            [symbolSelect, symbolSearchInput, fetchChartButton, timeframeSelect, startDatetimeInput ].forEach(el => el.disabled = true);
            return;
        }
        try {
            showLoading(true); showError(''); setControlsDisabled(true); 
            const symbols = await fetchApi(`/symbols?exchange_id=${exchangeId}`, 'Ошибка загрузки пар');
            populateSymbolSelect(symbols);
            
            const controlsToEnable = [exchangeSelect, symbolSelect, symbolSearchInput, timeframeSelect, startDatetimeInput ];
            controlsToEnable.forEach(el => el.disabled = false);
            fetchChartButton.disabled = !(symbols && symbols.length > 0 && symbols[0] !== "Нет подходящих пар" && symbols[0] !== "Ошибка загрузки пар с биржи");

        } catch (error) {
            console.error('Error fetching symbols:', error); showError(error.message);
            symbolSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
            
            exchangeSelect.disabled = false;
            [symbolSelect, symbolSearchInput, timeframeSelect, startDatetimeInput,  fetchChartButton].forEach(el => el.disabled = true);
        } finally {
            showLoading(false);
        }
    }

    async function fetchKlinesAndDrawChart(isUpdate = false) {
        if (!isUpdate) { 
            currentChartRequestParams = {
                exchangeId: exchangeSelect.value,
                rawSymbol: symbolSearchInput.value.trim().toUpperCase() || symbolSelect.value,
                timeframe: timeframeSelect.value,
                startTimeValue: startDatetimeInput.value,
            };
            stopPriceUpdateTimer(); 
        }

        const params = currentChartRequestParams;
        if (!params || !params.exchangeId || !params.rawSymbol || !params.timeframe) {
            if (!isUpdate) showError('Пожалуйста, выберите биржу, пару и таймфрейм.');
            return;
        }
        
        let symbol = params.rawSymbol;
        if (!symbol.includes('/') && symbol.length > 3) {
            const commonSuffixes = ["USDT", "BUSD", "USDC", "BTC", "ETH", "USD", "EUR"];
            for (const suffix of commonSuffixes) {
                if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
                    const prefix = symbol.slice(0, -suffix.length);
                    if (prefix.length > 0) { symbol = prefix + "/" + suffix; break; }
                }
            }
        }
        if (!symbol.includes('/')) {
            if (!isUpdate) showError('Формат пары не распознан. Используйте формат типа BTC/USDT.');
            return;
        }

        let klinesUrl = `/klines?exchange_id=${params.exchangeId}&symbol=${encodeURIComponent(symbol)}&timeframe=${params.timeframe}`;
        
        if (isUpdate) {
            klinesUrl += `&limit=2`; 
        } else {
            if (params.startTimeValue) {
                const sinceTimestamp = new Date(params.startTimeValue.replace("T", " ") + "Z").getTime(); 
                if (!isNaN(sinceTimestamp)) { 
                    klinesUrl += `&since=${sinceTimestamp}&limit=1500`; 
                } else { 
                    if (!isUpdate) showError('Некорректная дата начала.'); return; 
                }
            } else {
                klinesUrl += `&limit=200`; 
            }
        }

        try {
            if (!isUpdate) { showLoading(true); showError(''); setControlsDisabled(true); }
            console.log("Requesting klines:", klinesUrl);
            const klines = await fetchApi(klinesUrl, 'Ошибка загрузки графика');
            
            if (!isUpdate) { 
                if (klines.length === 0) {
                    showError('Нет данных для отображения графика по этому запросу.');
                    if (candlestickSeries && chart) { chart.removeSeries(candlestickSeries); candlestickSeries = null; }
                    return; 
                }
                drawChart(klines); 
                if (!params.startTimeValue) { 
                    startPriceUpdateTimer();
                }
            } else if (candlestickSeries && klines.length > 0) { 
                klines.forEach(kline => {
                    candlestickSeries.update({
                        time: kline.timestamp / 1000,
                        open: kline.open, high: kline.high, low: kline.low, close: kline.close,
                        volume: kline.volume 
                    });
                });
            }

        } catch (error) {
            console.error('Error fetching klines:', error); 
            if (!isUpdate) showError(error.message);
        } finally {
            if (!isUpdate) { showLoading(false); setControlsDisabled(false); }
        }
    }
    
    function startPriceUpdateTimer() {
        stopPriceUpdateTimer(); 
        
        if (currentChartRequestParams && !currentChartRequestParams.startTimeValue) { 
            console.log('Starting price update timer...');
            updateIntervalId = setInterval(() => {
                console.log('Fetching price update...');
                fetchKlinesAndDrawChart(true); 
            }, UPDATE_INTERVAL_MS);
        }
    }

    function stopPriceUpdateTimer() {
        if (updateIntervalId) {
            console.log('Stopping price update timer...');
            clearInterval(updateIntervalId);
            updateIntervalId = null;
        }
    }

    function populateExchangeSelect(exchanges) {
        exchangeSelect.innerHTML = '<option value="">-- Выберите биржу --</option>';
        for (const id in exchanges) {
            const option = document.createElement('option');
            option.value = id; option.textContent = exchanges[id];
            exchangeSelect.appendChild(option);
        }
        exchangeSelect.disabled = false;
        [symbolSelect, symbolSearchInput, timeframeSelect, startDatetimeInput,  fetchChartButton].forEach(el => el.disabled = true);
    }

    function populateSymbolSelect(symbols) {
        symbolSelect.innerHTML = '<option value="">-- Выберите пару --</option>';
        let hasValidSymbols = false;
        if (symbols && symbols.length > 0) {
            symbols.forEach(symbol => {
                if (typeof symbol === 'string' && !symbol.startsWith("Ошибка") && symbol !== "Нет подходящих пар") {
                    const option = document.createElement('option');
                    option.value = symbol; option.textContent = symbol;
                    symbolSelect.appendChild(option);
                    hasValidSymbols = true;
                } else if (typeof symbol === 'string' && symbols.length === 1) {
                     symbolSelect.innerHTML = `<option value="">${symbol}</option>`; 
                }
            });
        }
        
        if (!hasValidSymbols && symbolSelect.options.length <= 1) { 
             symbolSelect.innerHTML = '<option value="">Нет доступных пар</option>';
        }
        
        
        const controlsToEnable = [symbolSelect, symbolSearchInput, timeframeSelect, startDatetimeInput ];
        controlsToEnable.forEach(el => el.disabled = !hasValidSymbols);
        fetchChartButton.disabled = !hasValidSymbols;
        
        if(hasValidSymbols) {
            timeframeSelect.disabled = false;
            startDatetimeInput.disabled = false;
            
        }
    }

    function drawChart(data) {
        if (!chartContainer) { showError('Ошибка: контейнер для графика не найден.'); return; }
        const chartWidth = chartContainer.clientWidth; const chartHeight = chartContainer.clientHeight;
        if (chartWidth === 0 || chartHeight === 0) {
            console.warn('Контейнер графика имеет нулевые размеры. Попытка отрисовки может не удасться.');
            
        }

        const theme = (tg && tg.themeParams) || {};
        const chartOptions = {
            width: chartWidth, height: chartHeight,
            layout: { background: { type: 'solid', color: theme.bg_color || '#ffffff' }, textColor: theme.text_color || '#000000' },
            grid: { vertLines: { color: theme.secondary_bg_color || '#f0f0f0' }, horzLines: { color: theme.secondary_bg_color || '#f0f0f0' }},
            timeScale: { 
                timeVisible: true, 
                secondsVisible: false, 
                borderColor: theme.secondary_bg_color || '#D1D4DC', 
                
                
                rightOffset: 5, 
            },
            crosshair: { 
                mode: LightweightCharts.CrosshairMode.Normal, 
            },
            
            handleScroll: true,
            handleScale: true,
        };

        if (!chart) {
            try {
                chart = LightweightCharts.createChart(chartContainer, chartOptions);
                if (!chart || typeof chart.addCandlestickSeries !== 'function') {
                    showError('Не удалось корректно создать объект графика.'); chart = null; return;
                }
            } catch (e) { showError(`Ошибка при создании графика: ${e.message}`); chart = null; return; }
        } else { 
            chart.applyOptions(chartOptions); 
        }

        if (candlestickSeries) { try { chart.removeSeries(candlestickSeries); } catch (e) { console.warn("Error removing series:", e) } candlestickSeries = null; }

        try {
            candlestickSeries = chart.addCandlestickSeries({
                upColor: '#26a69a', downColor: '#ef5350',
                borderDownColor: '#ef5350', borderUpColor: '#26a69a',
                wickDownColor: '#ef5350', wickUpColor: '#26a69a',
            });
        } catch (e) { showError(`Ошибка при добавлении серии: ${e.message}`); return; }
        
        const chartData = data.map(kline => ({
            time: kline.timestamp / 1000,
            open: kline.open, high: kline.high, low: kline.low, close: kline.close,
            volume: kline.volume 
        }));

        candlestickSeries.setData(chartData);
        if (chart && chart.timeScale && chartData.length > 0) {
             
            if (!currentChartRequestParams || !currentChartRequestParams.startTimeValue || data.length > 50) { 
                chart.timeScale().fitContent();
            } else {
                
                
            }
        }
    }
    
    exchangeSelect.addEventListener('change', (event) => { fetchSymbols(event.target.value); symbolSearchInput.value = ''; stopPriceUpdateTimer(); });
    symbolSelect.addEventListener('change', () => { stopPriceUpdateTimer(); fetchChartButton.disabled = !symbolSelect.value; });
    symbolSearchInput.addEventListener('input', () => {
        if (symbolSearchInput.value.trim() !== '') { symbolSelect.value = ''; }
        fetchChartButton.disabled = !symbolSearchInput.value.trim() && !symbolSelect.value;
        stopPriceUpdateTimer();
    });
    timeframeSelect.addEventListener('change', () => { stopPriceUpdateTimer(); });
    startDatetimeInput.addEventListener('change', () => { stopPriceUpdateTimer(); });
    


    fetchChartButton.addEventListener('click', () => fetchKlinesAndDrawChart(false)); 

    window.addEventListener('resize', () => {
        if (chart && chartContainer) {
            chart.applyOptions({ 
                width: chartContainer.clientWidth, 
                height: chartContainer.clientHeight 
            });
        }
    });

    fetchExchanges();
});