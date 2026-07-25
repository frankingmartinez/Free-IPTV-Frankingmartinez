// ============================================
// IPTV PLAYER - CON BÚSQUEDA, FAVORITOS Y NUMERACIÓN
// ============================================

let hls = null;
let allChannels = [];
let currentChannelGroup = null;
let currentOptionIndex = 0;
let isHlsReady = false;
let retryTimeout = null;
let isFavoritesMode = false;
let searchQuery = '';

const video = document.getElementById('videoPlayer');
const spinner = document.getElementById('spinner');
const errorMsg = document.getElementById('errorMsg');
const nowPlaying = document.getElementById('nowPlaying');
const statusBadge = document.getElementById('statusBadge');
const optionsContainer = document.getElementById('optionsContainer');
const channelList = document.getElementById('channelList');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const showAllBtn = document.getElementById('showAllBtn');
const favoritesBtn = document.getElementById('favoritesBtn');
const favoritesCount = document.getElementById('favoritesCount');

// ============================================
// 1. GESTIÓN DE FAVORITOS (localStorage)
// ============================================
function getFavorites() {
    try {
        const data = localStorage.getItem('iptv_favorites');
        return data ? JSON.parse(data) : [];
    } catch {
        return [];
    }
}

function saveFavorites(favorites) {
    localStorage.setItem('iptv_favorites', JSON.stringify(favorites));
    updateFavoritesCount();
}

function toggleFavorite(channelKey) {
    let favorites = getFavorites();
    const index = favorites.indexOf(channelKey);
    if (index > -1) {
        favorites.splice(index, 1);
    } else {
        favorites.push(channelKey);
    }
    saveFavorites(favorites);
    renderChannelList(); // Re-renderizar para actualizar iconos
}

function isFavorite(channelKey) {
    return getFavorites().includes(channelKey);
}

function updateFavoritesCount() {
    const favs = getFavorites();
    favoritesCount.textContent = favs.length;
    if (favs.length > 0) {
        favoritesBtn.classList.add('active');
    } else {
        favoritesBtn.classList.remove('active');
    }
}

// ============================================
// 2. PARSER M3U ROBUSTO
// ============================================
function parseM3U(content, sourceFile = '') {
    const channels = [];
    const lines = content.split(/\r?\n/);
    let currentExtinf = null;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith('#') && !line.startsWith('#EXTINF:')) continue;

        if (line.startsWith('#EXTINF:')) {
            currentExtinf = line;
            const urlMatch = line.match(/https?:\/\/[^\s"]+/);
            if (urlMatch) {
                const ch = parseChannel(currentExtinf, urlMatch[0], sourceFile);
                if (ch) channels.push(ch);
                currentExtinf = null;
            }
            continue;
        }

        if (line.startsWith('http://') || line.startsWith('https://') || line.startsWith('rtmp://')) {
            if (currentExtinf) {
                const ch = parseChannel(currentExtinf, line, sourceFile);
                if (ch) channels.push(ch);
                currentExtinf = null;
            }
            continue;
        }

        if (currentExtinf && !line.startsWith('#')) {
            const possibleUrl = line.trim();
            if (possibleUrl.startsWith('http://') || possibleUrl.startsWith('https://')) {
                const ch = parseChannel(currentExtinf, possibleUrl, sourceFile);
                if (ch) channels.push(ch);
                currentExtinf = null;
            }
        }
    }
    return channels;
}

function parseChannel(extinfLine, url, sourceFile) {
    try {
        extinfLine = extinfLine.replace(/^\uFEFF/, '').trim();
        url = url.trim();

        let name = 'Sin nombre';
        const nameMatch = extinfLine.match(/,([^,]+)$/);
        if (nameMatch) {
            name = nameMatch[1].trim().replace(/^"|"$/g, '');
        }

        let group = 'Sin categoría';
        const groupMatch = extinfLine.match(/group-title="([^"]*)"/);
        if (groupMatch) {
            group = groupMatch[1].trim();
            if (!group) group = 'Sin categoría';
        }

        let priority = 'secondary';
        const priorityMatch = extinfLine.match(/priority="([^"]*)"/);
        if (priorityMatch) {
            priority = priorityMatch[1].trim().toLowerCase();
            if (!['primary', 'secondary'].includes(priority)) priority = 'secondary';
        }

        if (!url || (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('rtmp://'))) {
            return null;
        }

        return { name, url, group, priority, source: sourceFile };
    } catch (error) {
        return null;
    }
}

// ============================================
// 3. AGRUPAR CANALES POR NOMBRE
// ============================================
function groupChannelsByName(channels) {
    const groups = {};
    channels.forEach(ch => {
        let cleanName = ch.name
            .replace(/\s*\(Opt\s*\d+\)\s*/gi, '')
            .replace(/\s*\[Opt\s*\d+\]\s*/gi, '')
            .replace(/\s*📡\s*/g, '')
            .trim();

        const key = cleanName.toLowerCase();
        if (!groups[key]) {
            groups[key] = {
                name: cleanName,
                group: ch.group,
                options: [],
                priority: ch.priority,
                key: key // Para favoritos
            };
        }
        
        const urlExists = groups[key].options.some(opt => opt.url === ch.url);
        if (!urlExists) {
            groups[key].options.push({
                url: ch.url,
                source: ch.source || 'Desconocido',
                priority: ch.priority
            });
        }
        
        if (ch.priority === 'primary') {
            groups[key].priority = 'primary';
        }
    });
    
    Object.values(groups).forEach(group => {
        group.options.sort((a, b) => {
            if (a.priority === 'primary' && b.priority !== 'primary') return -1;
            if (a.priority !== 'primary' && b.priority === 'primary') return 1;
            return 0;
        });
    });
    
    return Object.values(groups);
}

// ============================================
// 4. CARGAR playlist.m3u PRINCIPAL
// ============================================
// ============================================
// CARGAR playlist.m3u (ÚNICO ARCHIVO)
// ============================================
async function loadMainPlaylist() {
    let rawChannels = [];

    try {
        const response = await fetch('playlist.m3u');
        if (!response.ok) {
            console.error('❌ No se pudo cargar playlist.m3u');
            // Mostrar mensaje en pantalla
            document.getElementById('channelList').innerHTML = `
                <div class="no-results">
                    <span>⚠️</span>
                    No se pudo cargar la lista de canales.<br>
                    <small>Verificá que el archivo <strong>playlist.m3u</strong> exista en el servidor.</small>
                </div>
            `;
            return;
        }
        const text = await response.text();
        const cleanText = text.replace(/^\uFEFF/, '');
        const parsed = parseM3U(cleanText, 'playlist.m3u');
        rawChannels = rawChannels.concat(parsed);
        console.log(`✅ playlist.m3u: ${parsed.length} canales`);
    } catch (error) {
        console.error('❌ Error cargando playlist.m3u:', error);
        document.getElementById('channelList').innerHTML = `
            <div class="no-results">
                <span>⚠️</span>
                Error al cargar la lista de canales.<br>
                <small>${error.message}</small>
            </div>
        `;
        return;
    }

    if (rawChannels.length === 0) {
        console.warn('⚠️ No se cargaron canales');
        document.getElementById('channelList').innerHTML = `
            <div class="no-results">
                <span>📭</span>
                No se encontraron canales en playlist.m3u.<br>
                <small>Verificá que el archivo tenga el formato correcto.</small>
            </div>
        `;
        return;
    }

    allChannels = groupChannelsByName(rawChannels);
    console.log(`📊 AGRUPADOS: ${allChannels.length} canales únicos (${allChannels.reduce((acc, ch) => acc + ch.options.length, 0)} opciones totales)`);

    if (allChannels.length === 0) {
        console.warn('⚠️ No se cargaron canales, usando respaldo...');
        allChannels = getBackupChannels();
    }

    renderChannelList();
}

function getBackupChannels() {
    return [
        { 
            name: "TyC Sports", 
            group: "⭐ ARGENTINA (Sin Latencia)", 
            priority: "primary",
            key: "tyc sports",
            options: [
                { url: "http://181.94.205.55:4022/udp/225.2.2.2:20017", source: "Respaldo", priority: "primary" }
            ]
        },
        { 
            name: "Telefe", 
            group: "⭐ ARGENTINA (Sin Latencia)", 
            priority: "primary",
            key: "telefe",
            options: [
                { url: "http://181.94.205.55:4022/udp/225.2.2.2:20012", source: "Respaldo", priority: "primary" }
            ]
        }
    ];
}

// ============================================
// 5. FILTRAR CANALES (búsqueda + favoritos)
// ============================================
function getFilteredChannels() {
    let filtered = [...allChannels];

    // Filtro por favoritos
    if (isFavoritesMode) {
        const favs = getFavorites();
        filtered = filtered.filter(ch => favs.includes(ch.key || ch.name.toLowerCase()));
    }

    // Filtro por búsqueda
    if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        filtered = filtered.filter(ch => 
            ch.name.toLowerCase().includes(query) ||
            ch.group.toLowerCase().includes(query)
        );
    }

    return filtered;
}

// ============================================
// 6. RENDERIZAR TABLERO (con numeración y favoritos)
// ============================================
function renderChannelList() {
    const container = document.getElementById('channelList');
    container.innerHTML = '';
    
    const filtered = getFilteredChannels();
    
    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="no-results">
                <span>🔍</span>
                ${isFavoritesMode ? 'No tenés canales favoritos aún.' : 'No se encontraron canales.'}
                <br><small style="color: #444;">${isFavoritesMode ? 'Agregá canales presionando el icono +' : 'Probá con otra búsqueda.'}</small>
            </div>
        `;
        document.getElementById('channelCount').textContent = `0 canales`;
        return;
    }

    // Agrupar por categoría
    const groups = {};
    filtered.forEach(ch => {
        const groupName = ch.group || 'Sin categoría';
        if (!groups[groupName]) groups[groupName] = [];
        groups[groupName].push(ch);
    });

    const totalOptions = filtered.reduce((acc, ch) => acc + ch.options.length, 0);
    document.getElementById('channelCount').textContent = `${filtered.length} canales (${totalOptions} opciones)`;

    const sortedGroups = Object.keys(groups).sort((a, b) => {
        if (a.startsWith('⭐') && !b.startsWith('⭐')) return -1;
        if (!a.startsWith('⭐') && b.startsWith('⭐')) return 1;
        if (a.startsWith('🔵') && !b.startsWith('🔵')) return -1;
        if (!a.startsWith('🔵') && b.startsWith('🔵')) return 1;
        return a.localeCompare(b);
    });

    let globalIndex = 1;

    for (const groupName of sortedGroups) {
        const groupChannels = groups[groupName];
        const groupDiv = document.createElement('div');
        groupDiv.className = 'channel-group';
        
        const titleDiv = document.createElement('div');
        titleDiv.className = 'group-title';
        titleDiv.textContent = `${groupName} (${groupChannels.length})`;
        groupDiv.appendChild(titleDiv);
        
        groupChannels.forEach(ch => {
            const item = document.createElement('div');
            item.className = 'channel-item';
            
            // NÚMERO
            const numberSpan = document.createElement('span');
            numberSpan.className = 'number';
            numberSpan.textContent = globalIndex++;
            item.appendChild(numberSpan);
            
            // PRIORIDAD
            const prioritySpan = document.createElement('span');
            prioritySpan.className = `priority ${ch.priority || 'secondary'}`;
            prioritySpan.textContent = ch.priority === 'primary' ? '⭐' : '🔵';
            item.appendChild(prioritySpan);
            
            // NOMBRE
            const nameSpan = document.createElement('span');
            nameSpan.className = 'name';
            const optionCount = ch.options.length;
            nameSpan.textContent = `${ch.name} ${optionCount > 1 ? `📡 +${optionCount - 1}` : ''}`;
            item.appendChild(nameSpan);
            
            // BOTÓN DE FAVORITO (+)
            const favBtn = document.createElement('button');
            favBtn.className = 'fav-btn';
            const channelKey = ch.key || ch.name.toLowerCase();
            const isFav = isFavorite(channelKey);
            favBtn.textContent = isFav ? '⭐' : '☆';
            favBtn.classList.toggle('favorited', isFav);
            favBtn.title = isFav ? 'Quitar de favoritos' : 'Agregar a favoritos';
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleFavorite(channelKey);
            });
            item.appendChild(favBtn);
            
            item.title = `${ch.options.length} opción(es) disponible(s)`;
            
            item.addEventListener('click', () => {
                document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                currentChannelGroup = ch;
                currentOptionIndex = 0;
                playChannelOption(ch.options[0]);
                renderOptions(ch);
            });
            
            groupDiv.appendChild(item);
        });
        
        container.appendChild(groupDiv);
    }

    // Auto-reproducir si no hay reproducción activa
    if (!currentChannelGroup) {
        const firstPrimary = filtered.find(ch => ch.priority === 'primary');
        if (firstPrimary) {
            const items = container.querySelectorAll('.channel-item');
            if (items.length > 0) items[0].classList.add('active');
            currentChannelGroup = firstPrimary;
            currentOptionIndex = 0;
            playChannelOption(firstPrimary.options[0]);
            renderOptions(firstPrimary);
        } else if (filtered.length > 0) {
            const items = container.querySelectorAll('.channel-item');
            if (items.length > 0) items[0].classList.add('active');
            currentChannelGroup = filtered[0];
            currentOptionIndex = 0;
            playChannelOption(filtered[0].options[0]);
            renderOptions(filtered[0]);
        }
    }
}

// ============================================
// 7. RENDERIZAR OPCIONES
// ============================================
// ============================================
// 7. RENDERIZAR OPCIONES (con indicador de audio-only)
// ============================================
function renderOptions(channel) {
    if (!optionsContainer) return;
    
    if (!channel || channel.options.length <= 1) {
        optionsContainer.innerHTML = '';
        optionsContainer.style.display = 'none';
        return;
    }

    optionsContainer.style.display = 'flex';
    optionsContainer.innerHTML = `
        <span style="color: #888; font-size: 11px; margin-right: 8px; white-space: nowrap;">📡 Opciones:</span>
        ${channel.options.map((opt, index) => {
            const isActive = index === currentOptionIndex;
            const label = opt.priority === 'primary' ? '⭐' : '🔵';
            const sourceShort = opt.source ? opt.source.replace('.m3u', '').replace('.m3u8', '').slice(0, 8) : '';
            // Si es la opción activa y está en estado de solo audio, mostrar ícono
            const isAudioOnly = isActive && statusBadge.classList.contains('audioonly');
            return `
                <button class="option-btn ${isActive ? 'active' : ''} ${isAudioOnly ? 'audioonly-btn' : ''}" 
                        data-index="${index}"
                        data-url="${opt.url}"
                        title="Fuente: ${opt.source || 'Desconocido'} | Prioridad: ${opt.priority}">
                    ${isAudioOnly ? '🔊 ' : ''}${label} Opt ${index + 1}
                    <span class="source-label">${sourceShort}</span>
                </button>
            `;
        }).join('')}
    `;

    optionsContainer.querySelectorAll('.option-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(btn.dataset.index);
            if (currentChannelGroup && currentChannelGroup.options[index]) {
                currentOptionIndex = index;
                optionsContainer.querySelectorAll('.option-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                playChannelOption(currentChannelGroup.options[index]);
                nowPlaying.textContent = `${currentChannelGroup.name} (Opt ${index + 1})`;
            }
        });
    });
}

// ============================================
// 8. REPRODUCIR UNA OPCIÓN (CON RETRASO EN ERRORES)
// ============================================

// ===== SISTEMA DE CÓDIGOS DE ERROR =====
const ERROR_CODES = {
    NETWORK_ERROR: { code: 'ERR_001', message: '❌ Error de red. Verificá tu conexión a internet.', short: 'Sin conexión' },
    STREAM_NOT_FOUND: { code: 'ERR_002', message: '❌ El stream no está disponible. Probá con otra opción.', short: 'Stream caído' },
    STREAM_TIMEOUT: { code: 'ERR_003', message: '⏱️ El servidor tardó demasiado en responder. Probá con otra opción.', short: 'Timeout' },
    STREAM_AUDIO_ONLY: { code: 'ERR_004', message: '🔊 Este stream solo transmite AUDIO. No hay señal de video disponible. Probá con otra opción.', short: 'Solo audio' },
    STREAM_NO_VIDEO: { code: 'ERR_005', message: '🎬 El stream no contiene video. Probá con otra opción.', short: 'Sin video' },
    STREAM_UNSUPPORTED: { code: 'ERR_006', message: '⚠️ El formato de este stream no es compatible con tu navegador. Probá con otra opción.', short: 'Formato no soportado' },
    HLS_ERROR: { code: 'ERR_007', message: '❌ Error al cargar el stream HLS. Probá con otra opción.', short: 'Error HLS' },
    MEDIA_ERROR: { code: 'ERR_008', message: '❌ Error en el reproductor multimedia. Probá con otra opción.', short: 'Error multimedia' },
    SERVER_ERROR: { code: 'ERR_009', message: '⚠️ El servidor del stream no responde (posiblemente caído o con límite de usuarios). Probá con otra opción.', short: 'Servidor caído' },
    CLIENT_LIMIT: { code: 'ERR_010', message: '⚠️ El servidor tiene límite de usuarios. Intentá de nuevo en unos minutos.', short: 'Límite de usuarios' },
    LOAD_FAILED: { code: 'ERR_011', message: '❌ No se pudo cargar el stream. Probá con otra opción.', short: 'Carga fallida' },
    MANIFEST_ERROR: { code: 'ERR_012', message: '❌ Error al cargar el manifiesto del stream. Probá con otra opción.', short: 'Manifiesto inválido' },
    UNKNOWN: { code: 'ERR_999', message: '⚠️ Error desconocido. Probá con otra opción o recargá la página.', short: 'Error desconocido' }
};

// ===== FUNCIÓN PARA MOSTRAR ERROR CON RETRASO =====
let errorTimeoutId = null;

function showErrorWithDelay(errorKey, details = '', delay = 3000) {
    // Cancelar cualquier error pendiente
    if (errorTimeoutId) {
        clearTimeout(errorTimeoutId);
        errorTimeoutId = null;
    }
    
    // Si el video ya está reproduciendo correctamente, no mostrar error
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        console.log('✅ Stream detectado, cancelando mensaje de error.');
        return;
    }
    
    // Mostrar error después del retraso
    errorTimeoutId = setTimeout(() => {
        // Verificar nuevamente antes de mostrar
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
            console.log('✅ Stream detectado durante el retraso, cancelando error.');
            return;
        }
        
        const error = ERROR_CODES[errorKey] || ERROR_CODES.UNKNOWN;
        const fullMessage = details ? `${error.message} (${details})` : error.message;
        
        spinner.classList.remove('show');
        errorMsg.textContent = fullMessage;
        errorMsg.classList.add('show');
        statusBadge.textContent = `❌ ${error.short}`;
        statusBadge.className = 'status offline';
        
        console.warn(`[${error.code}] ${error.short}: ${details || 'Sin detalles'}`);
        errorTimeoutId = null;
    }, delay);
}

// ===== FUNCIÓN PARA CANCELAR ERROR PENDIENTE =====
function cancelPendingError() {
    if (errorTimeoutId) {
        clearTimeout(errorTimeoutId);
        errorTimeoutId = null;
    }
    errorMsg.classList.remove('show');
}

// ===== FUNCIÓN PRINCIPAL DE REPRODUCCIÓN =====
function playChannelOption(option) {
    if (!option) {
        showErrorWithDelay('STREAM_NOT_FOUND', 'No se encontró la URL del stream', 1000);
        return;
    }
    
    // Cancelar errores pendientes al cambiar de canal
    cancelPendingError();
    
    if (retryTimeout) {
        clearTimeout(retryTimeout);
        retryTimeout = null;
    }
    
    if (hls) {
        try { hls.destroy(); } catch (e) {}
        hls = null;
        isHlsReady = false;
    }
    
    video.pause();
    video.removeAttribute('src');
    video.load();
    
    errorMsg.classList.remove('show');
    errorMsg.classList.remove('audioonly');
    errorMsg.className = 'error-msg';
    spinner.classList.add('show');
    statusBadge.textContent = '⏳ Cargando...';
    statusBadge.className = 'status loading';
    
    const url = String(option.url).trim();
    const channelName = currentChannelGroup ? currentChannelGroup.name : 'Cargando...';
    nowPlaying.textContent = `${channelName} (Opt ${currentOptionIndex + 1})`;

    // ===== VARIABLES DE CONTROL =====
    let audioOnlyDetected = false;
    let audioCheckTimer = null;
    let errorShown = false;
    let loadTimeout = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    let streamStarted = false;

    // ===== FUNCIÓN PARA MANEJAR ERRORES =====
    function handleStreamError(errorKey, details = '') {
        if (errorShown) return;
        if (streamStarted) return; // Si ya empezó el stream, no mostrar error
        errorShown = true;
        stopAudioCheck();
        if (loadTimeout) {
            clearTimeout(loadTimeout);
            loadTimeout = null;
        }
        showErrorWithDelay(errorKey, details, 3000);
    }

    // ===== FUNCIÓN PARA MARCAR STREAM INICIADO =====
    function markStreamStarted() {
        streamStarted = true;
        cancelPendingError();
        if (loadTimeout) {
            clearTimeout(loadTimeout);
            loadTimeout = null;
        }
        spinner.classList.remove('show');
        statusBadge.textContent = '✅ En vivo';
        statusBadge.className = 'status online';
    }

    // ===== FUNCIÓN PARA VERIFICAR AUDIO-ONLY =====
    function startAudioCheck() {
        if (audioCheckTimer) {
            clearInterval(audioCheckTimer);
        }
        audioCheckTimer = setInterval(() => {
            if (video.paused) return;
            if (video.readyState >= 2 && detectAudioOnly()) {
                if (!audioOnlyDetected) {
                    audioOnlyDetected = true;
                    stopAudioCheck();
                    // Esperar 2 segundos antes de confirmar audio-only
                    setTimeout(() => {
                        if (video.readyState >= 2 && detectAudioOnly() && !streamStarted) {
                            handleStreamError('STREAM_AUDIO_ONLY', `Video: ${video.videoWidth}x${video.videoHeight}, ReadyState: ${video.readyState}`);
                        }
                    }, 2000);
                }
            }
        }, 1000);
    }

    function stopAudioCheck() {
        if (audioCheckTimer) {
            clearInterval(audioCheckTimer);
            audioCheckTimer = null;
        }
    }

    // ===== TIMEOUT DE CARGA (con retraso) =====
    loadTimeout = setTimeout(() => {
        if (!errorShown && !streamStarted) {
            handleStreamError('STREAM_TIMEOUT', 'El stream no respondió en el tiempo esperado');
        }
    }, 15000);

    // ===== CONFIGURAR HLS =====
    if (url.includes('.m3u8') || url.includes('playlist') || url.includes('hls')) {
        if (Hls.isSupported()) {
            hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                maxBufferLength: 10,
                maxMaxBufferLength: 20,
                maxBufferSize: 30 * 1000 * 1000,
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 5,
                enableWebVTT: false,
                fragLoadingMaxRetry: 5,
                fragLoadingRetryDelay: 500,
                manifestLoadingMaxRetry: 3,
                manifestLoadingRetryDelay: 1000,
                startLevel: -1,
                abrEwmaDefaultEstimate: 500000,
                abrBandWidthFactor: 0.8,
                abrBandWidthUpFactor: 1.2,
            });
            
            hls.loadSource(url);
            hls.attachMedia(video);
            
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                markStreamStarted();
                video.play().catch((err) => {
                    if (err.name === 'NotAllowedError') {
                        statusBadge.textContent = '⏸ Click para reproducir';
                        statusBadge.className = 'status loading';
                    } else if (!errorShown) {
                        handleStreamError('MEDIA_ERROR', err.message);
                    }
                });
                // Verificar audio-only después de 3 segundos
                setTimeout(() => {
                    if (!audioOnlyDetected && detectAudioOnly() && !streamStarted) {
                        handleStreamError('STREAM_AUDIO_ONLY', 'Sin señal de video detectada');
                    } else if (!audioOnlyDetected && !errorShown) {
                        startAudioCheck();
                    }
                }, 3000);
            });
            
            hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
                if (data.details && data.details.videoCodec === undefined) {
                    setTimeout(() => {
                        if (!audioOnlyDetected && !errorShown && detectAudioOnly() && !streamStarted) {
                            handleStreamError('STREAM_NO_VIDEO', 'El stream no contiene codec de video');
                        }
                    }, 3000);
                }
            });
            
            hls.on(Hls.Events.FRAG_LOADED, () => {
                if (!streamStarted) {
                    markStreamStarted();
                }
                if (video.videoWidth > 0 || video.videoHeight > 0) {
                    stopAudioCheck();
                    if (audioOnlyDetected) {
                        audioOnlyDetected = false;
                        cancelPendingError();
                        statusBadge.textContent = '✅ En vivo';
                        statusBadge.className = 'status online';
                    }
                }
            });
            
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (errorShown || streamStarted) return;
                
                if (data.fatal) {
                    let errorKey = 'HLS_ERROR';
                    let details = '';
                    
                    if (data.response && data.response.code) {
                        errorKey = detectErrorFromStatus(data.response.code, url);
                        details = `HTTP ${data.response.code}`;
                    } else if (data.details) {
                        details = data.details;
                        if (data.details.includes('timeout')) errorKey = 'STREAM_TIMEOUT';
                        if (data.details.includes('404')) errorKey = 'STREAM_NOT_FOUND';
                        if (data.details.includes('503')) errorKey = 'CLIENT_LIMIT';
                    }
                    
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            if (retryCount < MAX_RETRIES) {
                                retryCount++;
                                console.warn(`🔄 Reintentando (${retryCount}/${MAX_RETRIES})...`);
                                hls.startLoad();
                                return;
                            }
                            handleStreamError('NETWORK_ERROR', details);
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            if (!errorShown) {
                                hls.recoverMediaError();
                                setTimeout(() => {
                                    if (!errorShown && !streamStarted && detectAudioOnly()) {
                                        handleStreamError('STREAM_AUDIO_ONLY', details);
                                    }
                                }, 2000);
                                return;
                            }
                            handleStreamError('MEDIA_ERROR', details);
                            break;
                        default:
                            handleStreamError(errorKey, details);
                            break;
                    }
                }
            });
            
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            video.addEventListener('loadedmetadata', () => {
                markStreamStarted();
                video.play().catch((err) => {
                    if (err.name === 'NotAllowedError') {
                        statusBadge.textContent = '⏸ Click para reproducir';
                        statusBadge.className = 'status loading';
                    }
                });
                setTimeout(() => {
                    if (!errorShown && !streamStarted && detectAudioOnly()) {
                        handleStreamError('STREAM_AUDIO_ONLY', 'Sin señal de video detectada');
                    }
                }, 3000);
            }, { once: true });
            
            video.addEventListener('error', (e) => {
                if (errorShown || streamStarted) return;
                const mediaError = video.error;
                if (mediaError) {
                    let errorKey = 'MEDIA_ERROR';
                    let details = `Código: ${mediaError.code}`;
                    switch (mediaError.code) {
                        case MediaError.MEDIA_ERR_ABORTED: return;
                        case MediaError.MEDIA_ERR_NETWORK:
                            errorKey = 'NETWORK_ERROR';
                            details = 'Error de red al cargar el stream';
                            break;
                        case MediaError.MEDIA_ERR_DECODE:
                            errorKey = 'STREAM_UNSUPPORTED';
                            details = 'El navegador no puede decodificar el stream';
                            break;
                        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                            errorKey = 'STREAM_UNSUPPORTED';
                            details = 'Formato de stream no compatible';
                            break;
                    }
                    handleStreamError(errorKey, details);
                }
            }, { once: true });
        } else {
            handleStreamError('STREAM_UNSUPPORTED', 'HLS no soportado en este navegador');
        }
    } else {
        video.src = url;
        video.addEventListener('loadedmetadata', () => {
            markStreamStarted();
            video.play().catch((err) => {
                if (err.name === 'NotAllowedError') {
                    statusBadge.textContent = '⏸ Click para reproducir';
                    statusBadge.className = 'status loading';
                }
            });
            setTimeout(() => {
                if (!errorShown && !streamStarted && detectAudioOnly()) {
                    handleStreamError('STREAM_AUDIO_ONLY', 'Sin señal de video detectada');
                }
            }, 3000);
        }, { once: true });
        
        video.addEventListener('error', (e) => {
            if (errorShown || streamStarted) return;
            const mediaError = video.error;
            if (mediaError) {
                let errorKey = 'MEDIA_ERROR';
                let details = `Código: ${mediaError.code}`;
                switch (mediaError.code) {
                    case MediaError.MEDIA_ERR_ABORTED: return;
                    case MediaError.MEDIA_ERR_NETWORK:
                        errorKey = 'NETWORK_ERROR';
                        details = 'Error de red al cargar el stream';
                        break;
                    case MediaError.MEDIA_ERR_DECODE:
                        errorKey = 'STREAM_UNSUPPORTED';
                        details = 'El navegador no puede decodificar el stream';
                        break;
                    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                        errorKey = 'STREAM_UNSUPPORTED';
                        details = 'Formato de stream no compatible';
                        break;
                }
                handleStreamError(errorKey, details);
            }
        }, { once: true });
    }

    const cleanup = () => {
        stopAudioCheck();
        if (loadTimeout) {
            clearTimeout(loadTimeout);
            loadTimeout = null;
        }
        cancelPendingError();
        audioOnlyDetected = false;
        errorShown = false;
        streamStarted = false;
    };
    
    video.addEventListener('emptied', cleanup, { once: true });
    
}

// ============================================
// 9. EVENTOS DE BÚSQUEDA Y FAVORITOS
// ============================================

// Búsqueda en tiempo real
searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    clearSearchBtn.style.display = searchQuery ? 'block' : 'none';
    if (isFavoritesMode && !searchQuery) {
        showAllBtn.style.display = 'block';
    } else {
        showAllBtn.style.display = 'none';
    }
    renderChannelList();
});

// Limpiar búsqueda
clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    clearSearchBtn.style.display = 'none';
    showAllBtn.style.display = 'none';
    renderChannelList();
});

// Mostrar todos (salir de favoritos)
showAllBtn.addEventListener('click', () => {
    isFavoritesMode = false;
    favoritesBtn.classList.remove('active');
    showAllBtn.style.display = 'none';
    searchInput.value = '';
    searchQuery = '';
    clearSearchBtn.style.display = 'none';
    renderChannelList();
});

// Toggle favoritos (⭐)
favoritesBtn.addEventListener('click', () => {
    isFavoritesMode = !isFavoritesMode;
    if (isFavoritesMode) {
        favoritesBtn.classList.add('active');
        // Mostrar botón para volver
        showAllBtn.style.display = 'block';
        showAllBtn.textContent = '⬅ Volver a todos';
        // Limpiar búsqueda al entrar a favoritos
        searchInput.value = '';
        searchQuery = '';
        clearSearchBtn.style.display = 'none';
    } else {
        favoritesBtn.classList.remove('active');
        showAllBtn.style.display = 'none';
    }
    renderChannelList();
});

// ============================================
// 10. INICIALIZAR
// ============================================
loadMainPlaylist();

video.addEventListener('error', (e) => {
    if (errorMsg.classList.contains('show')) return;
    if (e.target.error && e.target.error.code === MediaError.MEDIA_ERR_ABORTED) return;
    errorMsg.classList.add('show');
    statusBadge.textContent = '❌ Error';
    statusBadge.className = 'status offline';
    spinner.classList.remove('show');
});

console.log('📺 IPTV Player - Versión Definitiva con Búsqueda y Favoritos');
console.log('📁 Cargando playlist.m3u (principal)');
console.log('🔄 Canales duplicados se agrupan con opciones múltiples');
console.log('⭐ Guardá tus canales favoritos con el icono +');
console.log('🔍 Buscá canales en tiempo real');