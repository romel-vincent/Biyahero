import supabase from "./auth.js";
import { Heap } from "heap-js";


// ============================================================
// CONSTANTS
// ============================================================
const ICCT_POSITION     = [14.61768, 121.10261];
const MAX_DISTANCE      = 15000;
const ICCT_WALK_RADIUS  = 1000;
const TRANSFER_LIMIT    = 500;
const WALK_SPEED        = 1.4;
const JEEPNEY_SPEED     = 8;
const TRANSFER_PENALTY  = 600;
const DEBOUNCE_MS       = 8000;
const GEO_CACHE_LIMIT   = 1000;
const STOP_FETCH_LIMIT  = 2000;
const CANDIDATE_RADIUS  = 2000;
const END_STOP_RADIUS   = 1500;
const MOVE_THRESHOLD    = 50;    // meters — minimum movement to trigger recalculate
const PASSED_THRESHOLD  = 80;    // meters — how close to a stop before it's "passed"
const WALK_TRANSFER_THRESHOLD = 400;
 
// Graph cache: rebuild after 6 hours
const GRAPH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const GRAPH_CACHE_KEY    = "jeepney_graph_v1";

const API_KEY = import.meta.env.VITE_GEOAPIFY_KEY;


// ============================================================
// STATE
// ============================================================
let stops                 = [];
let stopById              = {};
let graph                 = null;
let stopRoutes            = {};
let routeEndpoints        = {};
let userMarker            = null;
let jeepneyRouteLayers    = [];
let walkingRouteLayer     = null;
let endWalkingRouteLayer  = null;
let transferWalkingLayers = [];
let watchId               = null;
let locationMode          = "idle";
let lastUserPos           = null;
let lastRun               = 0;
let lastCoords            = null;
let selectedJeepneyType   = "traditional";
let globalActivePathData  = null;
let lastAnnouncedStop = null;
let lastTransferAnnouncement = null;
let followUser = false;
let arrivalAnnounced = false;


// Route lock state
let routeLocked           = false;
let lockedPathData        = null;
let remainingPath         = null;

class LRUCache {
  constructor(max) { this.max = max; this.cache = new Map(); }
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    this.cache.delete(key); this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.max)
      this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, val);
  }
  has(key) { return this.cache.has(key); }
  delete(key) { this.cache.delete(key); }
}
const geoCache = new LRUCache(GEO_CACHE_LIMIT);


// ============================================================
// MAP SETUP
// ============================================================
const map = L.map("map", {
    attributionControl: false,
}).setView(ICCT_POSITION, 15);

map.on("dragstart", () => {
    if (routeLocked) {
        followUser = false;
    }
});

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
}).addTo(map);

L.marker(ICCT_POSITION)
    .addTo(map)
    .bindPopup("ICCT Cainta");

L.circle(ICCT_POSITION, {
    color:       "#17a",
    fillColor:   "blue",
    fillOpacity: 0.1,
    radius:      MAX_DISTANCE,
}).addTo(map);

// ============= MAP LEGEND ===============
const legend = L.control({ position: 'bottomright' });
    // legend.style.display = 'none';

legend.onAdd = function (map) {
    const div = L.DomUtil.create('div', 'map-legend');
    
    div.innerHTML = `
        <h4>Biyahero Legend</h4>
        <div class="legend-item">
            <span class="legend-line line-jeepney"></span>
            <span>Jeepney Route</span>
        </div>
        <div class="legend-item">
            <span class="legend-line line-walk-start"></span>
            <span>Walk to Ride</span>
        </div>
        <div class="legend-item">
            <span class="legend-line line-transfer"></span>
            <span>Transfer Point Walk</span>
        </div>
        <div class="legend-item">
            <span class="legend-line line-walk-end"></span>
            <span>Walk to Campus Entrance</span>
        </div>
        <div class="legend-item">
            <span class="legend-line line-traveled"></span>
            <span>Passed Route</span>
        </div>
    `;
    
    // Prevent clicking or scrolling on the legend box from messing with map movements
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    
    return div;
};

legend.addTo(map);

window.toggleMapLegend = function () {
    const legendContainer = document.querySelector('.map-legend');
    const toggleBtn = document.getElementById('toggleLegendBtn');
    
    if (!legendContainer) return;

    // Toggle the hidden CSS class
    const isHidden = legendContainer.classList.toggle('hidden');

    // Dynamically update the button label text
    if (toggleBtn) {
        toggleBtn.textContent = isHidden ? 'Legend' : 'Legend';
    }
};

// ─── NEW CODE: LEAFLET CONTROL BUTTON FOR TOGGLE ────────────────
const legendToggle = L.control({ position: 'bottomright' });

legendToggle.onAdd = function (map) {
    const button = L.DomUtil.create('button', 'legend-toggle-btn');
    button.id = 'toggleLegendBtn';
    button.textContent = 'Legend';

    L.DomEvent.on(button, 'click', function (e) {
        L.DomEvent.stopPropagation(e); // Stop map from clicking through
        window.toggleMapLegend();
    });

    return button;
};

legendToggle.addTo(map);

// ============================================================
// MAP CLEANUP
// ============================================================
function clearMapRoutes() {
    jeepneyRouteLayers.forEach(layer => map.removeLayer(layer));
    jeepneyRouteLayers = [];

    if (walkingRouteLayer) {
        map.removeLayer(walkingRouteLayer);
        walkingRouteLayer = null;
    }

    if (endWalkingRouteLayer) {
        map.removeLayer(endWalkingRouteLayer);
        endWalkingRouteLayer = null;
    }

    transferWalkingLayers.forEach(layer => map.removeLayer(layer));
    transferWalkingLayers = [];
}


// ============================================================
// DATA LOADING
// ============================================================
async function loadStops() {
    const { data, error } = await supabase
        .from("stops")
        .select("*")
        .range(0, STOP_FETCH_LIMIT);

    if (error) return [];

    stops = (data || []).map(s => ({
        id:   String(s.id),
        name: s.stop_name,
        lat:  Number(s.lat),
        lng:  Number(s.lng),
    }));

    stopById = Object.fromEntries(stops.map(stop => [stop.id, stop]));
    return stops;
}




// ============================================================
// GRAPH BUILDER
// ============================================================
async function buildGraph() {
    if (graph) return graph;
 
    // ── Try loading from cache ──────────────────────────────
    try {
        const cached = localStorage.getItem(GRAPH_CACHE_KEY);
        if (cached) {
            const { timestamp, data } = JSON.parse(cached);
            if (Date.now() - timestamp < GRAPH_CACHE_TTL_MS) {
                // Restore derived state from cache
                graph        = data.graph;
                stopRoutes   = data.stopRoutes;  // plain objects (Sets serialized as arrays)
                routeEndpoints = data.routeEndpoints;
 
                // Re-hydrate Sets
                for (const id in stopRoutes) stopRoutes[id] = new Set(stopRoutes[id]);
 
                // Stops may not be loaded yet if we hit the cache before loadStops()
                if (!stops.length) await loadStops();
 
                return graph;

            }
        }
    } catch {
        // Corrupt cache — rebuild
        localStorage.removeItem(GRAPH_CACHE_KEY);
    }
 
    // ── Build fresh ─────────────────────────────────────────
    await loadStops();
 
    const { data: routeStops, error } = await supabase
        .from("route_stops")
        .select("*")
        .order("route_id",   { ascending: true })
        .order("stop_order", { ascending: true });
 
    if (error) return {};
 
    const g = {};
    stopRoutes = {};
 
    for (const rs of routeStops) {
        const stopId = String(rs.stop_id);
        if (!stopRoutes[stopId]) stopRoutes[stopId] = new Set();
        stopRoutes[stopId].add(String(rs.route_id));
    }
 
    const grouped = {};
    for (const rs of routeStops) {
        const routeId = String(rs.route_id);
        if (!grouped[routeId]) grouped[routeId] = [];
        grouped[routeId].push(rs);
    }
 
    routeEndpoints = {};
    for (const routeId in grouped) {
        const sorted = grouped[routeId].sort((a, b) => a.stop_order - b.stop_order);
        const last = sorted[sorted.length - 1];
        if (last) routeEndpoints[routeId] = String(last.stop_id);
    }
 
    const addNode = id => { id = String(id); if (!g[id]) g[id] = []; };

// Then update the transfer edge calls to pass the tag:
if (distance <= TRANSFER_LIMIT) {
    const isShortWalk = distance <= WALK_TRANSFER_THRESHOLD;
    const transferWeight = isShortWalk
        ? distance / WALK_SPEED
        : TRANSFER_PENALTY + distance / WALK_SPEED;

    addEdge(a.id, b.id, transferWeight, "transfer", null, { isShortWalk });
    addEdge(b.id, a.id, transferWeight, "transfer", null, { isShortWalk });
}
 
    for (const routeId in grouped) {
        const list = grouped[routeId].sort((a, b) => a.stop_order - b.stop_order);
        for (let i = 0; i < list.length - 1; i++) {
            const fromStop = stopById[String(list[i].stop_id)];
            const toStop   = stopById[String(list[i + 1].stop_id)];
            if (!fromStop || !toStop) continue;
 
            const distance   = map.distance([fromStop.lat, fromStop.lng], [toStop.lat, toStop.lng]);
            const travelTime = distance / JEEPNEY_SPEED;
            addEdge(list[i].stop_id,     list[i + 1].stop_id, travelTime, "jeepney", routeId);
            addEdge(list[i + 1].stop_id, list[i].stop_id,     travelTime, "jeepney", routeId);
        }
    }
 
    for (let i = 0; i < stops.length; i++) {
        const a = stops[i];
        for (let j = i + 1; j < stops.length; j++) {
            const b = stops[j];
            if (Math.abs(a.lat - b.lat) > 0.0045 || Math.abs(a.lng - b.lng) > 0.0045) continue;
 
            const routesA = stopRoutes[String(a.id)] || new Set();
            const routesB = stopRoutes[String(b.id)] || new Set();
            if ([...routesA].some(r => routesB.has(r))) continue;
 
            const distance = map.distance([a.lat, a.lng], [b.lat, b.lng]);
if (distance <= TRANSFER_LIMIT) {
    const isShortWalk = distance <= WALK_TRANSFER_THRESHOLD;
    const transferWeight = isShortWalk
        ? distance / WALK_SPEED
        : TRANSFER_PENALTY + distance / WALK_SPEED;

    addEdge(a.id, b.id, transferWeight, "transfer", null, { isShortWalk });
    addEdge(b.id, a.id, transferWeight, "transfer", null, { isShortWalk });
}
        }
    }
 
    graph = g;
 
    // ── Persist to localStorage ─────────────────────────────
    try {
        // Sets → arrays for JSON serialisation
        const stopRoutesSerializable = {};
        for (const id in stopRoutes) stopRoutesSerializable[id] = [...stopRoutes[id]];
 
        localStorage.setItem(GRAPH_CACHE_KEY, JSON.stringify({
            timestamp: Date.now(),
            data: { graph, stopRoutes: stopRoutesSerializable, routeEndpoints },
        }));
    } catch {
        // Storage quota exceeded — silently skip
    }
 
    return graph;
}
 
 

// ============================================================
// TRANSFER DETECTION
// ============================================================
function detectTransfers(path) {
    const transfers = [];

    for (let i = 0; i < path.length - 1; i++) {
        const currentRoutes = stopRoutes[path[i]]     || new Set();
        const nextRoutes    = stopRoutes[path[i + 1]] || new Set();
        const sameRoute     = [...currentRoutes].some(r => nextRoutes.has(r));

        if (!sameRoute) transfers.push({ from: path[i], to: path[i + 1] });
    }

    return transfers;
}


// ============================================================
// ROUTING API (with cache)
// ============================================================
async function getRoute(lat1, lng1, lat2, lng2) {
  const key = `${lat1.toFixed(4)},${lng1.toFixed(4)}-${lat2.toFixed(4)},${lng2.toFixed(4)}`;
  if (geoCache.has(key)) return geoCache.get(key);

  const url = `https://api.geoapify.com/v1/routing?waypoints=${lat1},${lng1}|${lat2},${lng2}&mode=walk&apiKey=${API_KEY}`;
  const promise = fetch(url)
    .then(res => res.json())
    .then(data => { geoCache.set(key, data); return data; })
    .catch(() => { geoCache.delete(key); return null; });

  geoCache.set(key, promise);
  return promise;
}


// ============================================================
// NEAREST STOP
// Returns top N stops sorted by actual walking time via Geoapify

async function getBestNearestStops(lat, lng, limit = 15) {
  const candidates = stops
    .filter(stop => map.distance([lat,lng],[stop.lat,stop.lng]) <= 3500)
    .sort((a,b) =>
      map.distance([lat,lng],[a.lat,a.lng]) -
      map.distance([lat,lng],[b.lat,b.lng])
    )
    .slice(0, 20); // was 40 — halved to cut API calls

  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async stop => {
        try {
          const data = await getRoute(lat, lng, stop.lat, stop.lng);
          const walkTime = data?.features?.[0]?.properties?.time ?? Infinity;
          const walkDist = data?.features?.[0]?.properties?.distance
            ?? map.distance([lat,lng],[stop.lat,stop.lng]);
          return { ...stop, walkTime, walkDist };
        } catch {
          const airDist = map.distance([lat,lng],[stop.lat,stop.lng]);
          return { ...stop, walkTime: airDist / 1.1, walkDist: airDist };
        }
      })
    );
    batchResults.forEach(r => {
      if (r.status === "fulfilled") results.push(r.value);
    });
  }

  return results
    .filter(s => isFinite(s.walkTime))
    .sort((a,b) => a.walkTime - b.walkTime)
    .slice(0, limit);
}
// ============================================================
// DIJKSTRA
// ============================================================
function dijkstra(graph, start, targetPos = ICCT_POSITION) {
    start = String(start);

    const distances = {};
    const previous  = {};
    const visited   = new Set();

    const heuristic = (a) => {
        const stopA = stopById[a];
        if (!stopA) return 0;
        return map.distance([stopA.lat, stopA.lng], targetPos) / JEEPNEY_SPEED;
    };
    const pq = new Heap((a, b) => a.priority - b.priority);

    for (const node in graph) distances[node] = Infinity;

    distances[start] = 0;
    pq.push({ node: start, dist: 0, priority: 0 });

    while (pq.size()) {
        const { node, dist } = pq.pop();

        if (visited.has(node)) continue;
        visited.add(node);

        for (const edge of graph[node] || []) {
            const newDist = dist + edge.weight;

            if (newDist < distances[edge.to]) {
                distances[edge.to] = newDist;
                previous[edge.to]  = node;

                pq.push({
                    node:     edge.to,
                    dist:     newDist,
                    priority: newDist + heuristic(edge.to),
                });
            }
        }
    }

    return { distances, previous };
}


// ============================================================
// PATH BUILDER
// ============================================================
function buildPath(previous, start, goal) {
    start = String(start);
    goal  = String(goal);

    const path = [];
    let current = goal;

    while (current && current !== start) {
        path.unshift(current);
        current = previous[current];
    }

    if (current === start) path.unshift(start);
    return path;
}


// ============================================================
// USER MARKER
// ============================================================
function updateUserMarker(lat, lng) {
    if (!userMarker) {
        userMarker = L.marker([lat, lng])
            .addTo(map)
            .bindPopup("You are here");
    } else {
        userMarker.setLatLng([lat, lng]);
    }

    // Navigation mode
        if (routeLocked && followUser) {

        const point = map.project(
            [lat, lng],
            map.getZoom()
        );

        // User appears lower on screen
        point.y -= 150;

        map.panTo(
            map.unproject(
                point,
                map.getZoom()
            ),
            {
                animate: true
            }
        );
    }
}


// ============================================================
// DRAW ROUTES
// ============================================================
async function drawWalkingRoute(startLat, startLng, endLat, endLng, type = "start") {
    const data = await getRoute(startLat, startLng, endLat, endLng);
    if (!data?.features?.length) return;

    const latlngs = data.features[0].geometry.coordinates[0].map(c => [c[1], c[0]]);

    const layer = L.polyline(latlngs, {
        color:     type === "start" ? "green" : "orange",
        weight:    5,
        dashArray: "10,10",
    }).addTo(map);

    if (type === "start") {
        walkingRouteLayer = layer;
    } else {
        endWalkingRouteLayer = layer;
    }
}

async function drawTransferRoute(startLat, startLng, endLat, endLng, isShortWalk = false) {
    const data = await getRoute(startLat, startLng, endLat, endLng);
    if (!data?.features?.length) return;

    const latlngs = data.features[0].geometry.coordinates[0].map(c => [c[1], c[0]]);

    const layer = L.polyline(latlngs, {
        color:     isShortWalk ? "#00cc88" : "yellow", // green-teal for short walks
        weight:    isShortWalk ? 5 : 4,
        dashArray: isShortWalk ? "6,6" : "5,10",
    }).addTo(map);

    transferWalkingLayers.push(layer);
}

function drawJeepneySegments(path, transfers) {
    const transferPairs = new Set(transfers.map(t => `${t.from}-${t.to}`));

    const segments = [];
    let currentSegment = [];

    for (let i = 0; i < path.length; i++) {
        const stopData = stopById[path[i]];
        if (!stopData) continue;

        currentSegment.push([stopData.lat, stopData.lng]);

        if (i < path.length - 1 && transferPairs.has(`${path[i]}-${path[i + 1]}`)) {
            segments.push(currentSegment);
            currentSegment = [];
        }
    }

    if (currentSegment.length > 0) segments.push(currentSegment);

    segments.forEach(seg => {
        if (seg.length < 2) return;
        const layer = L.polyline(seg, { color: "#0066ff", weight: 6 }).addTo(map);
        jeepneyRouteLayers.push(layer);
    });
}


// ============================================================
// FARE CALCULATORS
// ============================================================
function calculateTraditionalFare(distanceInMeters, isDiscounted = false) {
    const distanceKm     = distanceInMeters / 1000;
    const baseKm         = 4;
    const baseFare       = isDiscounted ? 11.20 : 14.00;
    const succeedingRate = isDiscounted ?  1.60 :  2.00;

    if (distanceKm <= baseKm) return baseFare;
    return Math.round((baseFare + Math.ceil(distanceKm - baseKm) * succeedingRate) * 4) / 4;
}

function calculateModernFare(distanceInMeters, isDiscounted = false) {
    const distanceKm     = distanceInMeters / 1000;
    const baseKm         = 4;
    const baseFare       = isDiscounted ? 13.60 : 17.00;
    const succeedingRate = isDiscounted ?  1.96 :  2.40;

    if (distanceKm <= baseKm) return baseFare;
    return Math.round((baseFare + Math.ceil(distanceKm - baseKm) * succeedingRate) * 4) / 4;
}


// ============================================================
// ROUTE LOCK
// ============================================================
window.lockRoute = function () {
    if (!globalActivePathData) return;

    routeLocked = true;
    followUser = true;
    arrivalAnnounced = false;

    lockedPathData = { ...globalActivePathData };
    remainingPath = [...lockedPathData.path];

    // Immediately zoom to current location
    if (userMarker) {
        map.setView(
            userMarker.getLatLng(),
            18,
            {
                animate: true
            }
        );
    }

    updateLockUI(true);

    setStatusMessage(
        "Route locked. Navigation started.",
        "success"
    );
};

window.unlockRoute = function () {
    routeLocked    = false;
    lockedPathData = null;
    remainingPath  = null;
    followUser = false;
    arrivalAnnounced = false;
    lastAnnouncedStop = null;
    lastTransferAnnouncement = null;

    // Reset debounce so a fresh recalculation fires immediately on next GPS tick
    lastRun     = 0;
    lastUserPos = null;
    lastCoords  = null;

    updateLockUI(false);
    setStatusMessage("Route unlocked. Will recalculate on next movement.", "info");
};

function updateLockUI(locked) {
    const lockBtn   = document.getElementById("lockRouteBtn");
    const unlockBtn = document.getElementById("unlockRouteBtn");
    const badge     = document.getElementById("routeLockBadge");

    if (lockBtn)   lockBtn.style.display   = locked ? "none"         : "inline-block";
    if (unlockBtn) unlockBtn.style.display = locked ? "inline-block" : "none";
    if (badge)     badge.style.display     = locked ? "inline-block" : "none";
}

// Trim already-passed stops and redraw the route with a gray "traveled" portion
function updateLockedRouteProgress(lat, lng) {
    if (!routeLocked || !remainingPath || remainingPath.length < 2) return;

    // Progress %
    const totalStops = lockedPathData.path.length;
    const remainingStopsCount = remainingPath.length;

    const progress =
        ((totalStops - remainingStopsCount) / totalStops) * 100;

    setStatusMessage(
        `Following route • ${progress.toFixed(0)}% completed`,
        "success"
    );

    let passedCount = 0;

    // Transfer points in current route
    const transfers = detectTransfers(remainingPath);

    for (let i = 0; i < remainingPath.length - 1; i++) {
        const stop = stopById[remainingPath[i]];
        if (!stop) continue;

        const distanceToStop = map.distance(
            [lat, lng],
            [stop.lat, stop.lng]
        );

        // ===================================================
        // APPROACHING STOP ANNOUNCEMENT
        // ===================================================
        if (
            distanceToStop <= 100 &&
            lastAnnouncedStop !== stop.id
        ) {
            lastAnnouncedStop = stop.id;

            speechSynthesis.speak(
                new SpeechSynthesisUtterance(
                    `Approaching ${stop.name}`
                )
            );
        }

        // ===================================================
        // TRANSFER ANNOUNCEMENT
        // ===================================================
        const transferPoint = transfers.find(
            t => t.from === stop.id
        );

        if (
            transferPoint &&
            distanceToStop <= 150 &&
            lastTransferAnnouncement !== stop.id
        ) {
            lastTransferAnnouncement = stop.id;

            speechSynthesis.speak(
                new SpeechSynthesisUtterance(
                    `Prepare to transfer at ${stop.name}`
                )
            );
        }

        // ===================================================
        // PASSED STOP CHECK
        // ===================================================
        if (distanceToStop <= PASSED_THRESHOLD) {
            passedCount = i + 1;
        } else {
            break;
        }
    }

    if (passedCount > 0) {
        remainingPath = remainingPath.slice(passedCount);
        redrawLockedRoute();
    }

    const finalStop = stopById[remainingPath[remainingPath.length - 1]];

        if (
            finalStop &&
            map.distance([lat, lng], [finalStop.lat, finalStop.lng]) < PASSED_THRESHOLD &&
            !arrivalAnnounced
        ) {
            arrivalAnnounced = true;

            speechSynthesis.speak(
                new SpeechSynthesisUtterance(
                    "You have arrived at your destination."
                )
            );
        }

    renderRouteDetails();
}

function redrawLockedRoute() {
    if (!lockedPathData || !remainingPath) return;

    clearMapRoutes();

    const fullPath      = lockedPathData.path;
    const passedCount   = fullPath.length - remainingPath.length;
    const passedCoords  = fullPath
        .slice(0, passedCount + 1)
        .map(id => {
            const s = stopById[id];
            return s ? [s.lat, s.lng] : null;
        })
        .filter(Boolean);

    // Gray line for already-traveled portion
    if (passedCoords.length >= 2) {
        const grayLayer = L.polyline(passedCoords, {
            color:   "#aaaaaa",
            weight:  5,
            opacity: 0.5,
        }).addTo(map);
        jeepneyRouteLayers.push(grayLayer);
    }

    // Blue line for remaining portion
    const transfers = detectTransfers(remainingPath);
    drawJeepneySegments(remainingPath, transfers);
}


// ============================================================
// STATUS BAR
// ============================================================
function setStatusMessage(message, type = "info") {
    const bar = document.getElementById("routeStatusBar");
    if (!bar) return;

    const colors = {
        info:        "#0066ff",
        success:     "#28a745",
        warning:     "#ffc107",
        recalculate: "#ff6600",
    };

    bar.textContent   = message;
    bar.style.color   = colors[type] || colors.info;
    bar.style.display = "block";
}


// ============================================================
// MAIN ROUTE PROCESSOR
// ============================================================
async function processUserLocation(lat, lng) {
    updateUserMarker(lat, lng);

    // When locked: only update progress along existing route, never recalculate
    if (routeLocked) {
        updateLockedRouteProgress(lat, lng);
        return;
    }

    const posKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const now    = Date.now();

    if (now - lastRun < DEBOUNCE_MS) return;
    if (lastUserPos === posKey) return;

    lastRun     = now;
    lastUserPos = posKey;

    if (lastCoords && map.distance([lat, lng], lastCoords) < MOVE_THRESHOLD) return;

    lastCoords = [lat, lng];

    const loader = document.getElementById("mapLoader");
    if (loader) loader.style.display = "flex";
    setStatusMessage("Recalculating route...", "recalculate");

    try {
        if (map.distance([lat, lng], ICCT_POSITION) > MAX_DISTANCE) {
            showToast("You are more than 15km away from ICCT.");
            stopTracking();
            return;
        }

       await buildGraph();
clearMapRoutes();

// ── Direct walk check ─────────────────────────────────────────
const directWalk = await getRoute(lat, lng, ICCT_POSITION[0], ICCT_POSITION[1]);
const walkOnlyTime = directWalk?.features?.[0]?.properties?.time  ?? Infinity;
const walkOnlyDist = directWalk?.features?.[0]?.properties?.distance ?? Infinity;

// ── Candidate start stops (multi-start) ──────────────────────
const startStops = await getBestNearestStops(lat, lng, 25);
if (!startStops.length) {
    showToast("No nearby stops found.");
    return;
}

// ── Candidate end stops (near ICCT) ──────────────────────────
const destinationCandidates = stops
    .map(stop => ({ stop, distToICCT: map.distance([stop.lat, stop.lng], ICCT_POSITION) }))
    .filter(({ distToICCT }) => distToICCT <= 5000)
    .sort((a, b) => a.distToICCT - b.distToICCT);

if (!destinationCandidates.length) {
    showToast("No stops near ICCT found.");
    return;
}

// ── Multi-start Dijkstra + scoring ────────────────────────────
let bestStartStop  = null;
let bestEndStop    = null;
let bestPath       = [];
let minTotalWeight = Infinity;
let bestActualTime = Infinity;

for (const startCandidate of startStops) {
    const { distances, previous } = dijkstra(graph, startCandidate.id);

    for (const { stop: endStop, distToICCT } of destinationCandidates) {
        const rideWeight = distances[endStop.id];
        if (!isFinite(rideWeight)) continue;

        const walkTimeToStart = startCandidate.walkTime
            ?? map.distance([lat, lng], [startCandidate.lat, startCandidate.lng]) / 1.4;

        const terminalBonus = startCandidate.isTerminal ? 300 : 0;
        const startHubBonus = /cupang|tropical|sta\.?\s*lucia/i.test(startCandidate.name) ? 200 : 0;
        const walkingToStartWeight = (walkTimeToStart * 1.5) - terminalBonus - startHubBonus;

        const walkingToEndWeight = distToICCT / 1.4;

        const hubDiscount = /icct/i.test(endStop.name) ? 1200
            : /tropical|sta\.?\s*lucia|cupang/i.test(endStop.name) ? 800
            : 0;

        const distanceBonus = (3000 - distToICCT) / 2;

        const totalWeight = walkingToStartWeight + rideWeight + walkingToEndWeight - hubDiscount - distanceBonus;

        if (totalWeight < minTotalWeight) {
            const tempPath = buildPath(previous, startCandidate.id, endStop.id);
            if (tempPath.length >= 2) {
                minTotalWeight = totalWeight;
                bestStartStop  = startCandidate;
                bestEndStop    = endStop;
                bestPath       = tempPath;
                bestActualTime = walkTimeToStart + rideWeight + walkingToEndWeight;
            }
        }
    }
}

// ── Walk-only fallback ────────────────────────────────────────
if (walkOnlyDist < 2000 && (walkOnlyTime < bestActualTime + 300 || !isFinite(bestActualTime))) {
    const walkCoords = directWalk.features[0].geometry.coordinates[0].map(c => [c[1], c[0]]);
    walkingRouteLayer = L.polyline(walkCoords, { color: "green", weight: 5, dashArray: "10,10" }).addTo(map);
    globalActivePathData = {
        path: [],
        transfers: [],
        startStop: { name: "Your Location", lat, lng },
        bestEndStop: { name: "ICCT Cainta", lat: ICCT_POSITION[0], lng: ICCT_POSITION[1] },
    };
    renderRouteDetails();
    setStatusMessage("You're close enough to walk directly to ICCT.", "success");
    return;
}

if (!bestPath.length || !bestEndStop || !bestStartStop) {
    showToast("No jeepney route found to ICCT from this location.");
    return;
}

// ── Draw routes ───────────────────────────────────────────────
await drawWalkingRoute(lat, lng, bestStartStop.lat, bestStartStop.lng, "start");

const transfers = detectTransfers(bestPath);
drawJeepneySegments(bestPath, transfers);

for (const t of transfers) {
    const fromStop = stopById[t.from];
    const toStop   = stopById[t.to];
    if (!fromStop || !toStop) continue;

    const dist = map.distance(
        [fromStop.lat, fromStop.lng],
        [toStop.lat, toStop.lng]
    );
    const isShortWalk = dist <= WALK_TRANSFER_THRESHOLD;

    await drawTransferRoute(
        fromStop.lat, fromStop.lng,
        toStop.lat,   toStop.lng,
        isShortWalk   // pass flag to draw differently
    );
}

globalActivePathData = { path: bestPath, transfers, startStop: bestStartStop, bestEndStop };
remainingPath        = [...bestPath];

renderRouteDetails();
setStatusMessage("Route ready. Lock it to start navigating.", "success");

const lastStop = stopById[bestPath[bestPath.length - 1]];
if (lastStop) {
    const distToICCT = map.distance([lastStop.lat, lastStop.lng], ICCT_POSITION);
    if (distToICCT <= ICCT_WALK_RADIUS) {
        await drawWalkingRoute(lastStop.lat, lastStop.lng, ICCT_POSITION[0], ICCT_POSITION[1], "end");
    }
}
    } catch {
        setStatusMessage("Error calculating route.", "warning");
    } finally {
        if (loader) loader.style.display = "none";
    }
}


// ============================================================
// JEEPNEY TYPE TOGGLE
// ============================================================
window.setJeepneyType = function (type) {
    selectedJeepneyType = type;
    renderRouteDetails();
};

// ============================================================
// ROUTE DETAILS PANEL
// ============================================================
function renderRouteDetails() {
    if (!globalActivePathData) return;

    const displayPath = (routeLocked && remainingPath?.length) ? remainingPath : globalActivePathData.path;
    const { transfers, startStop, bestEndStop } = globalActivePathData;

    let totalTripRegularFare    = 0;
    let totalTripDiscountedFare = 0;
    let totalTripDistanceMeters = 0;
    let currentRouteId          = null;
    let currentSegmentDistance  = 0;
    let jeepneyLegsHTML         = "";
    let legCount                = 1;

    const fareCalculator = selectedJeepneyType === "modern"
        ? calculateModernFare
        : calculateTraditionalFare;

    const flushSegment = () => {
        if (currentRouteId === null || currentSegmentDistance <= 0) return;

        const regFare  = fareCalculator(currentSegmentDistance, false);
        const discFare = fareCalculator(currentSegmentDistance, true);

        totalTripRegularFare    += regFare;
        totalTripDiscountedFare += discFare;

        jeepneyLegsHTML += `
            <b>Jeepney ${legCount} (Route ${currentRouteId}):</b>
            ${(currentSegmentDistance / 1000).toFixed(2)} km<br>
            &nbsp;&nbsp;&nbsp;&nbsp;Regular: ₱${regFare.toFixed(2)} | Disc: ₱${discFare.toFixed(2)}<br><br>`;

        legCount++;
        currentRouteId         = null;
        currentSegmentDistance = 0;
    };

    for (let i = 0; i < displayPath.length - 1; i++) {
        const currentStopId = displayPath[i];
        const nextStopId    = displayPath[i + 1];
        const edge          = (graph[currentStopId] || []).find(e => String(e.to) === String(nextStopId));
        

        if (!edge) continue;

        const edgeDistance = map.distance(
            [stopById[currentStopId].lat, stopById[currentStopId].lng],
            [stopById[nextStopId].lat,    stopById[nextStopId].lng]
        );

        if (edge.type === "jeepney") {
            totalTripDistanceMeters += edgeDistance;

            if (currentRouteId === null) {
                currentRouteId         = edge.routeId;
                currentSegmentDistance = edgeDistance;
            } else if (edge.routeId === currentRouteId) {
                currentSegmentDistance += edgeDistance;
            } else {
                flushSegment();
                currentRouteId         = edge.routeId;
                currentSegmentDistance = edgeDistance;
            }
        } else if (edge.type === "transfer") {
            flushSegment();
        }
    }

    flushSegment();

    const transferHTML = transfers
    .map((t, i) => {
        const from = stopById[t.from];
        const to   = stopById[t.to];
        if (!from || !to) return "";

        const dist = map.distance(
            [from.lat, from.lng],
            [to.lat,   to.lng]
        );
        const isShortWalk = dist <= WALK_TRANSFER_THRESHOLD;
        const walkMins    = Math.ceil((dist / WALK_SPEED) / 60);
        const badge       = isShortWalk
            ? `<span style="background:#00cc88;color:#fff;font-size:10px;
                padding:1px 6px;border-radius:8px;margin-left:4px;">Just Walk</span>`
            : "";

        return `
            <b>Transfer ${i + 1}:</b> Walk from <i>${from.name}</i>
            to <i>${to.name}</i> ${badge}<br>
            <span style="font-size:0.85em;color:#666;">
                ~${Math.round(dist)}m · ${walkMins} min walk
            </span><br><br>`;
    })
    .join("");

    const isModern       = selectedJeepneyType === "modern";
    const btnBase        = "flex:1;padding:8px;cursor:pointer;font-weight:bold;border-radius:4px;border:1px solid #0066ff;";
    const btnOn          = `${btnBase}background-color:#0066ff;color:#fff;`;
    const btnOff         = `${btnBase}background-color:#fff;color:#0066ff;`;
    const remainingStops = (routeLocked && remainingPath) ? remainingPath.length : displayPath.length;

    const lockBtnHTML = routeLocked
        ? `<button id="unlockRouteBtn" onclick="window.unlockRoute()"
               style="width:100%;padding:8px;margin-bottom:10px;cursor:pointer;font-weight:bold;
                      border-radius:4px;border:1px solid #d9534f;background:#d9534f;color:#fff;">
                Unlock Route (Allow Recalculation)
           </button>`
        : `<button id="lockRouteBtn" onclick="window.lockRoute()"
               style="width:100%;padding:8px;margin-bottom:10px;cursor:pointer;font-weight:bold;
                      border-radius:4px;border:1px solid #28a745;background:#28a745;color:#fff;">
                Lock This Route
           </button>`;

    const lockedBadge = routeLocked
        ? `<span id="routeLockBadge" style="display:inline-block;background:#28a745;color:#fff;
               font-size:11px;padding:2px 8px;border-radius:10px;margin-left:6px;">LOCKED</span>`
        : `<span id="routeLockBadge" style="display:none;"></span>`;

    const panel = document.getElementById("routeInfo");
    const toggleBtn = document.getElementById("toggleRouteBtn");

    if (!panel) return;

    // 1. STOPS GHOST BARS: If there's no active route data, hide everything and get out early!
    if (!globalActivePathData) {
        panel.style.display = "none";
        if (toggleBtn) toggleBtn.style.display = "none";
        return;
    }

    // 2. SAFE TO PROCEED: We officially have data to show. Set up map event isolation.
    L.DomEvent.disableClickPropagation(panel);
    L.DomEvent.disableScrollPropagation(panel);

    if (toggleBtn) {
        toggleBtn.style.display = "block"; 
        L.DomEvent.disableClickPropagation(toggleBtn); // Fixed: Now safely inside braces
    }

    // 3. VISIBILITY CHECK: Only default to block if it isn't explicitly minimized ("none")
    // and isn't uninitialized ("") while data exists.
    if (panel.style.display === "" || panel.style.display === "block") {
        panel.style.display = "block";
    }
    // Set responsive dynamic constraint bounds
    panel.style.maxHeight = "calc(100% - 150px)"; 
    panel.style.overflowY = "auto";

    panel.innerHTML = `
        <div style="font-family:sans-serif;line-height:1.4;">
            <h3 style="margin:0 0 8px 0;color:#0066ff;">
                Active Route Directions ${lockedBadge}
            </h3>

            ${lockBtnHTML}

            <div style="display:flex;gap:10px;margin-bottom:15px;">
                <button onclick="window.setJeepneyType('traditional')" style="${!isModern ? btnOn : btnOff}">
                    Traditional PUJ
                </button>
                <button onclick="window.setJeepneyType('modern')" style="${isModern ? btnOn : btnOff}">
                    Modern Jeepney
                </button>
            </div>

            <b>Origin:</b> ${startStop.name}<br><br>
            <b>Destination:</b> ${bestEndStop.name}<br><br>
            <b>Total Ride:</b> ${(totalTripDistanceMeters / 1000).toFixed(2)} km

            <hr style="border:0;border-top:1px solid #ccc;margin:10px 0;">

            <h4 style="margin:0 0 5px 0;color:#333;">
                Fare &amp; Ride Breakdown (${selectedJeepneyType.toUpperCase()})
            </h4>
            ${jeepneyLegsHTML}
            ${transferHTML
                ? `<div style="margin-top:5px;font-size:0.9em;color:#555;">${transferHTML}</div>`
                : ""}

            <hr style="border:0;border-top:1px solid #ccc;margin:10px 0;">

            <h4 style="margin:0 0 5px 0;color:#d9534f;">Total Estimated Trip Cost</h4>
            <div style="font-size:1.1em;background:#f9f9f9;padding:8px;border-radius:4px;border-left:4px solid #d9534f;">
                <b>Regular Total:</b>
                <span style="font-weight:bold;color:#333;">₱${totalTripRegularFare.toFixed(2)}</span><br>
                <b>Discounted Total:</b>
                <span style="font-weight:bold;color:#5cb85c;">₱${totalTripDiscountedFare.toFixed(2)}</span>
            </div>
        </div>
    `;
}


// ============================================================
// DEBOUNCE
// ============================================================
function debounce(fn, delay = 400) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}


// ============================================================
// LOCATION SEARCH
// ============================================================
const input = document.getElementById("locationInput");
const box   = document.getElementById("suggestions");

input.addEventListener("input", debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) { box.innerHTML = ""; return; }

    const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(q)}&filter=circle:${ICCT_POSITION[1]},${ICCT_POSITION[0]},15000&apiKey=${API_KEY}`;

    try {
        const res  = await fetch(url);
        const data = await res.json();
        renderSuggestions(data.features || []);
    } catch {
        // Silently fail
    }
}));

function renderSuggestions(features) {
    box.innerHTML = "";

    features.forEach(place => {
        const div       = document.createElement("div");
        div.className   = "suggestion-item";
        div.textContent = place.properties.formatted;

        div.onclick = async () => {
            stopTracking();
            locationMode = "search";

            const lat = place.properties.lat;
            const lng = place.properties.lon;

            map.flyToBounds(
                [[lat, lng], ICCT_POSITION],
                { padding: [60, 60], animate: true, duration: 1 }
            );

            await processUserLocation(lat, lng);
            input.value = place.properties.formatted;
            box.innerHTML = "";
        };

        box.appendChild(div);
    });
}


// ============================================================
// GPS TRACKING
// ============================================================
function startTracking() {
    stopTracking();

    let running = false;

    watchId = navigator.geolocation.watchPosition(
        async position => {
            if (running) return;
            running = true;

            try {
                const { latitude, longitude, accuracy } = position.coords;
                if (accuracy > 120) {
                setStatusMessage(
                    `Waiting for GPS signal… (±${Math.round(accuracy)}m)`,
                    "warning"
                );
                return;
}
             await processUserLocation(latitude, longitude);
            } catch {
                // Silently handle
            } finally {
                running = false;
            }
        },
        error => {
            const messages = {
                [error.PERMISSION_DENIED]:    "Location permission denied.",
                [error.POSITION_UNAVAILABLE]: "Location unavailable.",
                [error.TIMEOUT]:              "GPS timeout. Retrying...",
            };
            showToast(messages[error.code] || "Unknown GPS error.");
        },
        {
            enableHighAccuracy: true,
            maximumAge: 3000,
            timeout:    30000,
        }
    );
}

function stopTracking() {
    if (watchId) navigator.geolocation.clearWatch(watchId);
    watchId = null;
}


// ============================================================
// FULLSCREEN CONTROL
// ============================================================
const FullscreenControl = L.Control.extend({
    options: { position: "topright" },

    onAdd() {
        const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const link      = L.DomUtil.create("a", "", container);

        link.href      = "#";
        link.innerHTML = "⛶";
        link.title     = "Toggle Fullscreen";

        L.DomEvent.disableClickPropagation(container);

        link.onclick = e => {
            e.preventDefault();
            if (!document.fullscreenElement) {
                document.getElementById("map").requestFullscreen();
            } else {
                document.exitFullscreen();
            }
        };

        document.addEventListener("fullscreenchange", () => {
            link.innerHTML = document.fullscreenElement ? "✕" : "⛶";
            setTimeout(() => map.invalidateSize(), 300);
        });

        return container;
    }
});

map.addControl(new FullscreenControl());
// ============================================================
// RECENTER CONTROL
// ============================================================
const RecenterControl = L.Control.extend({
    options: { position: "bottomright" },

    onAdd() {
        const container = L.DomUtil.create(
            "div",
            "leaflet-bar leaflet-control"
        );

        const btn = L.DomUtil.create(
            "a",
            "",
            container
        );

        btn.href = "#";
        btn.innerHTML = "📍";
        btn.title = "Center on me";

        btn.style.fontSize = "20px";
        btn.style.textAlign = "center";

        L.DomEvent.disableClickPropagation(container);

        btn.onclick = e => {
            e.preventDefault();

            followUser = true;

            if (userMarker) {
                map.flyTo(
                    userMarker.getLatLng(),
                    18,
                    {
                        animate: true,
                        duration: 1
                    }
                );
            }
        };

        return container;
    }
});

map.addControl(new RecenterControl());

// asa

// ============================================================
// FARE PANEL TOGGLE CONTROL
// ============================================================
const FareToggleControl = L.Control.extend({
    options: { position: "topright" }, // Stacks directly below the fullscreen button

    onAdd() {
        const container = L.DomUtil.create("div", "leaflet-control");
        const btn       = L.DomUtil.create("button", "", container);

        btn.id        = "toggleRouteBtn";
        btn.innerHTML = "◀";
        btn.title     = "Hide Details";
        btn.style.display = "none"; // Starts hidden until a route is calculated

        L.DomEvent.disableClickPropagation(container);

        btn.onclick = e => {
            e.preventDefault();
            window.toggleRoutePanel();
        };

        return container;
    }
});

// Add it to the map AFTER the fullscreen control so it sits underneath it
map.addControl(new FareToggleControl());

// ============================================================
// FARE PANEL TOGGLE
// ============================================================
window.toggleRoutePanel = function () {
    const panel = document.getElementById("routeInfo");
    const btn = document.getElementById("toggleRouteBtn");
    
    if (!panel || !btn) return;

    // Direct inline-style check matching your state management pattern
    if (panel.style.display === "none") {
        panel.style.display = "block";
        btn.innerHTML = "◀";
        btn.title = "Hide Details";
        btn.style.background = "#ffffff";
        btn.style.color = "#333";
    } else {
        panel.style.display = "none";
        btn.innerHTML = "▶";
        btn.title = "Show Details";
        btn.style.background = "#6D94C5";
        btn.style.color = "#ffffff";
    }
};

// Prevent map interactions when clicking/dragging the toggle button
const toggleBtn = document.getElementById("toggleRouteBtn");
if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => e.stopPropagation());
    toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    toggleBtn.addEventListener('touchstart', (e) => e.stopPropagation());
}

// ============================================================
// PUBLIC API
// ============================================================
window.startTracking = startTracking;
window.stopTracking  = stopTracking;

window.useCurrentLocation = () => {
    if (!navigator.geolocation) {
        showToast("GPS not supported in this browser.");
        return;
    }
    locationMode = "gps";
    stopTracking();
    startTracking();
};
function showToast(message, type = "info", duration = 4000) {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.style.cssText = `
      position:fixed; top:16px; left:50%; transform:translateX(-50%);
      z-index:9999; display:flex; flex-direction:column; gap:8px;
      pointer-events:none; min-width:260px;
    `;
    document.body.appendChild(container);
  }
  const colors = {
    info:"#0066ff", success:"#28a745",
    warning:"#ffc107", error:"#d9534f"
  };
  const toast = document.createElement("div");
  toast.style.cssText = `
    background:#fff; border-left:4px solid ${colors[type]||colors.info};
    padding:10px 16px; border-radius:6px; font-size:14px;
    box-shadow:0 2px 8px rgba(0,0,0,0.15); pointer-events:all;
  `;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function safeSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // clear queue first
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-PH";
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
}