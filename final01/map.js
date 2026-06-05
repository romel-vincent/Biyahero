import supabase from "./auth.js";
import { Heap } from "heap-js";
 
// ================= ICCT DATA =================
const icctPosition = [14.61768, 121.10261];
const MAX_DISTANCE = 15000;
const API_KEY = "1d12fe9921464d399f5924a62a2af7ba";
 
// ================= STATE =================
let stops = [];
let stopById = {};
let graph = null;
let hasCenteredRoute = false;
let stopRoutes = {};
let routeEndpoints = {};
let userMarker = null;
let jeepneyRouteLayers = []; // CHANGED: now an array of polylines
let walkingRouteLayer = null;
let endWalkingRouteLayer = null;
let transferWalkingLayers = [];
let watchId = null;
let locationMode = "idle";

let selectedJeepneyType = "traditional"; // Default choice: 'traditional' or 'modern'
let globalActivePathData = null;         // Caches the calculated route payload for on-the-fly re-rendering
 
 
const geoCache = new Map();
 
let lastUserPos = null;
let lastRun = 0;
let lastCoords = null;
 
const DEBOUNCE_MS = 3000;
 
// ================= MAP =================
const map = L.map("map", {
  attributionControl: false,
}).setView(icctPosition, 15);
 
L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
  }
).addTo(map);
 
L.marker(icctPosition)
  .addTo(map)
  .bindPopup("ICCT Cainta");
 
L.circle(icctPosition, {
  color: "#17a",
  fillColor: "blue",
  fillOpacity: 0.1,
  radius: MAX_DISTANCE,
}).addTo(map);
 
// ================= CLEAN MAP =================
function clearMapRoutes() {
  // CHANGED: loop and remove each jeepney segment
  jeepneyRouteLayers.forEach((layer) => {
    map.removeLayer(layer);
  });
  jeepneyRouteLayers = [];
 
  if (walkingRouteLayer) {
    map.removeLayer(walkingRouteLayer);
    walkingRouteLayer = null;
  }
 
  if (endWalkingRouteLayer) {
    map.removeLayer(endWalkingRouteLayer);
    endWalkingRouteLayer = null;
  }
 
  transferWalkingLayers.forEach((layer) => {
    map.removeLayer(layer);
  });
 
  transferWalkingLayers = [];
}
 
// ================= LOAD STOPS =================
async function loadStops() {
  const { data, error } = await supabase
    .from("stops")
    .select("*")
    .range (0, 2000)
 
  if (error) {
    console.error("LOAD STOPS ERROR:", error);
    return [];
  }
 
  stops = (data || []).map((s) => ({
    id: String(s.id),
    name: s.stop_name,
    lat: Number(s.lat),
    lng: Number(s.lng),
  }));
 
  stopById = Object.fromEntries(
    stops.map((stop) => [stop.id, stop])
  );
 
  return stops;
}
 
// ================= GRAPH =================
async function buildGraph() {
  if (graph) return graph;
 
  await loadStops();
 
  const { data: routeStops, error } = await supabase
    .from("route_stops")
    .select("*")
    .order("route_id", { ascending: true })
    .order("stop_order", { ascending: true });
 
  if (error) {
    console.error("GRAPH ERROR:", error);
    return {};
  }
 
  const g = {};
  stopRoutes = {};

  // ================= BUILD STOP ROUTES =================
  for (const rs of routeStops) {
    const stopId = String(rs.stop_id);
 
    if (!stopRoutes[stopId]) {
      stopRoutes[stopId] = new Set();
    }
 
    stopRoutes[stopId].add(String(rs.route_id));
  }
 
  // ================= GROUP ROUTES =================
  const grouped = {};
 
  for (const rs of routeStops) {
    const routeId = String(rs.route_id);
 
    if (!grouped[routeId]) {
      grouped[routeId] = [];
    }
 
    grouped[routeId].push(rs);
  }
 
  // ================= ROUTE ENDPOINTS =================
  routeEndpoints = {};
 
  for (const routeId in grouped) {
    const sorted = grouped[routeId].sort(
      (a, b) => a.stop_order - b.stop_order
    );
 
    const last = sorted[sorted.length - 1];
 
    if (last) {
      routeEndpoints[routeId] = String(last.stop_id);
    }
  }
 
  // ================= HELPERS =================
  const addNode = (id) => {
    id = String(id);
 
    if (!g[id]) {
      g[id] = [];
    }
  };
 
  const addEdge = (
    from,
    to,
    weight,
    type,
    routeId = null
  ) => {
    from = String(from);
    to = String(to);
 
    addNode(from);
    addNode(to);
 
    g[from].push({
      to,
      weight,
      type,
      routeId,
    });
  };
 
  // ================= JEEPNEY EDGES =================
  for (const routeId in grouped) {
    const list = grouped[routeId].sort(
      (a, b) => a.stop_order - b.stop_order
    );
 
    for (let i = 0; i < list.length - 1; i++) {
      const current = list[i];
      const next = list[i + 1];
 
      const fromStop = stopById[String(current.stop_id)];
      const toStop = stopById[String(next.stop_id)];
 
      if (!fromStop || !toStop) continue;
 
      const distance = map.distance(
        [fromStop.lat, fromStop.lng],
        [toStop.lat, toStop.lng]
      );
 
      const travelTime = distance / 8;
 
      // FORWARD
      addEdge(
        current.stop_id,
        next.stop_id,
        travelTime,
        "jeepney",
        routeId
      );
 
      // BACKWARD
      addEdge(
        next.stop_id,
        current.stop_id,
        travelTime,
        "jeepney",
        routeId
      );
    }
  }
 
  // ================= TRANSFERS =================
  const TRANSFER_LIMIT = 500;
 
  for (let i = 0; i < stops.length; i++) {
    const a = stops[i];
 
    for (let j = i + 1; j < stops.length; j++) {
      const b = stops[j];
 
      // QUICK FILTER
      if (
        Math.abs(a.lat - b.lat) > 0.0045 ||
        Math.abs(a.lng - b.lng) > 0.0045
      ) {
        continue;
      }
 
      const routesA = stopRoutes[String(a.id)] || new Set();
      const routesB = stopRoutes[String(b.id)] || new Set();
 
      const sameRoute = [...routesA].some((r) =>
        routesB.has(r)
      );
 
      if (sameRoute) continue;
 
      const distance = map.distance(
        [a.lat, a.lng],
        [b.lat, b.lng]
      );
 
      if (distance <= TRANSFER_LIMIT) {
        const transferWeight = 600 + distance / 1.4;
 
        addEdge(
          a.id,
          b.id,
          transferWeight,
          "transfer"
        );
 
        addEdge(
          b.id,
          a.id,
          transferWeight,
          "transfer"
        );
      }
    }
  }
 
  graph = g;
 
  console.log("GRAPH READY", graph);
 
  return graph;
}
 
// ================= DETECT TRANSFERS =================
function detectTransfers(path) {
  const transfers = [];
 
  for (let i = 0; i < path.length - 1; i++) {
    const currentRoutes =
      stopRoutes[path[i]] || new Set();
 
    const nextRoutes =
      stopRoutes[path[i + 1]] || new Set();
 
    const sameRoute = [...currentRoutes].some((r) =>
      nextRoutes.has(r)
    );
 
    if (!sameRoute) {
      transfers.push({
        from: path[i],
        to: path[i + 1],
      });
    }
  }
 
  return transfers;
}
 
// ================= GEO CACHE =================
async function getRoute(lat1, lng1, lat2, lng2) {
  const key = `${lat1.toFixed(4)},${lng1.toFixed(
    4
  )}-${lat2.toFixed(4)},${lng2.toFixed(4)}`;
 
  if (geoCache.has(key)) {
    return geoCache.get(key);
  }
 
  if (geoCache.size > 1000) {
    geoCache.clear();
  }
 
  const url = `https://api.geoapify.com/v1/routing?waypoints=${lat1},${lng1}|${lat2},${lng2}&mode=walk&apiKey=${API_KEY}`;
 
  const promise = fetch(url)
    .then((res) => res.json())
    .then((data) => {
      geoCache.set(key, data);
      return data;
    })
    .catch((err) => {
      console.error("ROUTING ERROR:", err);
      geoCache.delete(key);
      return null;
    });
 
  geoCache.set(key, promise);
 
  return promise;
}
 
// ================= NEAREST STOP =================
async function getNearestStop(lat, lng) {
  // Remove the air-distance pre-filter entirely
  // Fetch walk routes for ALL stops within a reasonable air radius (safety net only)
  const candidates = stops.filter((stop) => {
    const d = map.distance([lat, lng], [stop.lat, stop.lng]);
    return d <= 2000; // loose safety net, not a ranking filter
  });

  const results = await Promise.all(
    candidates.map(async (stop) => {
      const data = await getRoute(lat, lng, stop.lat, stop.lng);
      if (!data || !data.features?.length) return null;

      const props = data.features[0].properties;
      return { ...stop, walkTime: props.time };
    })
  );

  return results
    .filter(Boolean)
    .sort((a, b) => a.walkTime - b.walkTime)[0]; // rank purely by actual walk time
}
// ================= ICCT STOPS =================
function getICCTStops() {
  const ICCT_RADIUS = 1000;
 
  return stops.filter((stop) => {
    const d = map.distance(
      [stop.lat, stop.lng],
      icctPosition
    );
 
    return d <= ICCT_RADIUS;
  });
}
 
// ================= DIJKSTRA =================
function dijkstra(graph, start, goal) {
  start = String(start);
  goal = String(goal);
 
  const distances = {};
  const previous = {};
  const visited = new Set();
 
  const heuristic = (a, b) => {
    const stopA = stopById[a];
    const stopB = stopById[b];
 
    if (!stopA || !stopB) return 0;
 
    return (
      map.distance(
        [stopA.lat, stopA.lng],
        [stopB.lat, stopB.lng]
      ) / 8
    );
  };
 
  const pq = new Heap(
    (a, b) => a.priority - b.priority
  );
 
  for (const node in graph) {
    distances[node] = Infinity;
  }
 
  distances[start] = 0;
 
  pq.push({
    node: start,
    dist: 0,
    priority: 0,
  });
 
  while (pq.size()) {
    const current = pq.pop();
 
    const node = current.node;
    const dist = current.dist;
 
    if (visited.has(node)) continue;
 
    visited.add(node);
 
    if (node === goal) break;
 
    for (const edge of graph[node] || []) {
      const newDist = dist + edge.weight;
 
      if (newDist < distances[edge.to]) {
        distances[edge.to] = newDist;
        previous[edge.to] = node;
 
        const priority =
          newDist + heuristic(edge.to, goal);
 
        pq.push({
          node: edge.to,
          dist: newDist,
          priority,
        });
      }
    }
  }
 
  return {
    distances,
    previous,
  };
}
 
// ================= BUILD PATH =================
function buildPath(previous, start, goal) {
  start = String(start);
  goal = String(goal);
 
  const path = [];
 
  let current = goal;
 
  while (current && current !== start) {
    path.unshift(current);
    current = previous[current];
  }
 
  if (current === start) {
    path.unshift(start);
  }
 
  return path;
}
 
// ================= USER MARKER =================
function updateUserMarker(lat, lng) {
  if (!userMarker) {
    userMarker = L.marker([lat, lng])
      .addTo(map)
      .bindPopup("You are here");
  } else {
    userMarker.setLatLng([lat, lng]);
  }
}
 
// ================= WALKING ROUTE =================
async function drawWalkingRoute(
  startLat,
  startLng,
  endLat,
  endLng,
  type = "start"
) {
  const data = await getRoute(
    startLat,
    startLng,
    endLat,
    endLng
  );
 
  if (!data || !data.features?.length) return;
 
  const coords =
    data.features[0].geometry.coordinates[0];
 
  const latlngs = coords.map((c) => [c[1], c[0]]);
 
  const layer = L.polyline(latlngs, {
    color: type === "start" ? "green" : "orange",
    weight: 5,
    dashArray: "10,10",
  }).addTo(map);
 
  if (type === "start") {
    walkingRouteLayer = layer;
  } else {
    endWalkingRouteLayer = layer;
  }
}
 
// ================= TRANSFER WALK =================
async function drawTransferRoute(
  startLat,
  startLng,
  endLat,
  endLng
) {
  const data = await getRoute(
    startLat,
    startLng,
    endLat,
    endLng
  );
 
  if (!data || !data.features?.length) return;
 
  const coords =
    data.features[0].geometry.coordinates[0];
 
  const latlngs = coords.map((c) => [c[1], c[0]]);
 
  const layer = L.polyline(latlngs, {
    color: "yellow",
    weight: 4,
    dashArray: "5,10",
  }).addTo(map);
 
  transferWalkingLayers.push(layer);
}
 
// ================= DRAW JEEPNEY SEGMENTS =================
// CHANGED: splits the path into separate polylines, breaking at transfer edges
function drawJeepneySegments(path, transfers) {
  // Build a set of transfer edge keys for quick lookup
  const transferPairs = new Set(
    transfers.map((t) => `${t.from}-${t.to}`)
  );
 
  const segments = [];
  let currentSegment = [];
 
  for (let i = 0; i < path.length; i++) {
    const stopData = stopById[path[i]];
    if (!stopData) continue;
 
    currentSegment.push([stopData.lat, stopData.lng]);
 
    // If the next edge is a transfer, close this segment and start a new one
    if (i < path.length - 1) {
      const edgeKey = `${path[i]}-${path[i + 1]}`;
      if (transferPairs.has(edgeKey)) {
        segments.push(currentSegment);
        currentSegment = [];
      }
    }
  }
 
  // Push the last segment
  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }
 
  // Draw each segment as its own blue polyline
  segments.forEach((seg) => {
    if (seg.length < 2) return;
    const layer = L.polyline(seg, {
      color: "#0066ff",
      weight: 6,
    }).addTo(map);
    jeepneyRouteLayers.push(layer);
  });
}


// ================= CALCULATE JEEPNEY FARE =================
  function calculateTraditionalFare(distanceInMeters, isDiscounted = false) {
  const distanceKm = distanceInMeters / 1000;
  const baseKm = 4;
  const baseFare = isDiscounted ? 11.20 : 14.00;
  const succeedingRate = isDiscounted ? 1.60 : 2.00;

  if (distanceKm <= baseKm) return baseFare;

  const succeedingKm = Math.ceil(distanceKm - baseKm);
  let totalFare = baseFare + (succeedingKm * succeedingRate);

  return Math.round(totalFare * 4) / 4; // Round to nearest 0.25 centavos
}

// ================= CALCULATE MODERN JEEPNEY FARE =================
  function calculateModernFare(distanceInMeters, isDiscounted = false) {
  const distanceKm = distanceInMeters / 1000;
  const baseKm = 4;
  const baseFare = isDiscounted ? 13.60 : 17.00; // 17.00 base, less 20% is 13.60
  const succeedingRate = isDiscounted ? 1.96 : 2.40; // 2.40 per km vs 1.96 discount rate

  if (distanceKm <= baseKm) return baseFare;

  const succeedingKm = Math.ceil(distanceKm - baseKm);
  let totalFare = baseFare + (succeedingKm * succeedingRate);

  return Math.round(totalFare * 4) / 4; // Round to nearest 0.25 centavos
}

// ================= MAIN =================
async function processUserLocation(lat, lng) {
  const posKey = `${lat.toFixed(5)},${lng.toFixed(
    5
  )}`;
 
  const now = Date.now();
 
  if (now - lastRun < DEBOUNCE_MS) return;
  if (lastUserPos === posKey) return;
 
  lastRun = now;
  lastUserPos = posKey;
 
  if (lastCoords) {
    const moved = map.distance(
      [lat, lng],
      lastCoords
    );
 
    if (moved < 20) return;
  }
 
  lastCoords = [lat, lng];
 
  const loader = document.getElementById("mapLoader");
 
  if (loader) {
    loader.style.display = "flex";
  }
 
  try {
    const distanceToICCT = map.distance(
      [lat, lng],
      icctPosition
    );
 
    if (distanceToICCT > MAX_DISTANCE) {
      alert("You are more than 15km away from ICCT");
      stopTracking();
      return;
    }
 
    await buildGraph();
 
    clearMapRoutes();
 
    updateUserMarker(lat, lng);
 
    const startStop = await getNearestStop(lat, lng);
 
    if (!startStop) {
      alert("No nearby stop found.");
      return;
    }
 
    // ================= FIND BEST ROUTE ENDPOINT =================
const { distances, previous } = dijkstra(graph, startStop.id, null);
 
    let bestEndStop = null;
    let bestScore = Infinity;
 
    // 2. Evaluate every stop in the system to find the optimal exit point
    stops.forEach((stop) => {
      const jeepneyTime = distances[stop.id];
      
      // Skip if the stop is unreachable via jeepney from the start
      if (jeepneyTime === undefined || jeepneyTime === Infinity) return;
 
      // Calculate the actual walking distance from this stop to ICCT Cainta
      const distToICCT = map.distance(
        [stop.lat, stop.lng],
        icctPosition
      );
 
      // Only consider stops within a reasonable walking distance to ICCT (e.g., 1500 meters)
      if (distToICCT > 1500) return;
 
      // Total Travel Time = Time spent on Jeepney(s) + Walking Time to ICCT (speed ~1.4 m/s)
      const walkTime = distToICCT / 1.4;
      const totalJourneyTime = jeepneyTime + walkTime;
 
      // We want to minimize the total door-to-door transit time
      if (totalJourneyTime < bestScore) {
        bestScore = totalJourneyTime;
        bestEndStop = stop;
      }
    });
 
    if (!bestEndStop) {
      alert("No route found to ICCT.");
      return;
    }
 
    // 3. Build the path using the globally generated previous tracking map
    const path = buildPath(
      previous,
      startStop.id,
      bestEndStop.id
    );

    await drawWalkingRoute(
      lat,
      lng,
      startStop.lat,
      startStop.lng,
      "start"
    );
 
    if (!path.length) {
      alert("Unable to build route path.");
      return;
    }
 
    const transfers = detectTransfers(path);
 
    console.log("TRANSFERS:", transfers);
 
    // CHANGED: draw segmented jeepney lines (no connection across transfers)
    drawJeepneySegments(path, transfers);

    for (const t of transfers) {
      const fromStop = stopById[t.from];
      const toStop = stopById[t.to];
      
      if (fromStop && toStop) {
        await drawTransferRoute(
          fromStop.lat, 
          fromStop.lng, 
          toStop.lat, 
          toStop.lng
        );
      }
    }
    // ================= CACHE ROUTE INFORMATION FOR POPUP PICKER =================
    globalActivePathData = {
      path: path,
      transfers: transfers,
      startStop: startStop,
      bestEndStop: bestEndStop,
      totalTripDistanceMeters: 0 // Will be evaluated step by step
    };

    // Trigger UI rendering 
    renderRouteDetails();

    const lastStopId = path[path.length - 1];
    const lastStop = stopById[lastStopId];
 
    if (lastStop) {
      const walkDistanceToICCT = map.distance(
        [lastStop.lat, lastStop.lng],
        icctPosition
      );
 
      if (walkDistanceToICCT <= 1000) {
        await drawWalkingRoute(
          lastStop.lat,
          lastStop.lng,
          icctPosition[0],
          icctPosition[1],
          "end"
        );
      }
    }
  } catch (error) {
    console.error(
      "Error processing route map tracking:",
      error
    );
  } finally {
    if (loader) {
      loader.style.display = "none";
    }
  }
}
 
  // ================= JEEPNEY TYPE TOGGLE SELECTOR =================
window.setJeepneyType = function(type) {
  selectedJeepneyType = type;
  renderRouteDetails();
};

// ================= RENDER DIRECTIONS & FARES PANEL =================
function renderRouteDetails() {
  if (!globalActivePathData) return;

  const { path, transfers, startStop, bestEndStop } = globalActivePathData;

  let totalTripRegularFare = 0;
  let totalTripDiscountedFare = 0;
  let totalTripDistanceMeters = 0;

  let currentRouteId = null;
  let currentSegmentDistance = 0;
  let jeepneyLegsHTML = "";
  let legCount = 1;

  // Choose the appropriate engine dynamically
  const fareCalculator = selectedJeepneyType === "modern" ? calculateModernFare : calculateTraditionalFare;

  for (let i = 0; i < path.length - 1; i++) {
    const currentStopId = path[i];
    const nextStopId = path[i + 1];

    const edges = graph[currentStopId] || [];
    const edge = edges.find(e => String(e.to) === String(nextStopId));

    if (edge) {
      const edgeDistance = map.distance(
        [stopById[currentStopId].lat, stopById[currentStopId].lng],
        [stopById[nextStopId].lat, stopById[nextStopId].lng]
      );

      if (edge.type === "jeepney") {
        totalTripDistanceMeters += edgeDistance;

        if (currentRouteId === null) {
          currentRouteId = edge.routeId;
          currentSegmentDistance = edgeDistance;
        } else if (edge.routeId === currentRouteId) {
          currentSegmentDistance += edgeDistance;
        } else {
          const regFare = fareCalculator(currentSegmentDistance, false);
          const discFare = fareCalculator(currentSegmentDistance, true);
          
          totalTripRegularFare += regFare;
          totalTripDiscountedFare += discFare;

          jeepneyLegsHTML += `<b>Jeepney ${legCount} (Route ${currentRouteId}):</b> ${(currentSegmentDistance / 1000).toFixed(2)} km<br>
                              &nbsp;&nbsp;&nbsp;&nbsp;Regular: ₱${regFare.toFixed(2)} | Disc: ₱${discFare.toFixed(2)}<br><br>`;
          
          legCount++;
          currentRouteId = edge.routeId;
          currentSegmentDistance = edgeDistance;
        }
      } else if (edge.type === "transfer") {
        if (currentRouteId !== null && currentSegmentDistance > 0) {
          const regFare = fareCalculator(currentSegmentDistance, false);
          const discFare = fareCalculator(currentSegmentDistance, true);
          
          totalTripRegularFare += regFare;
          totalTripDiscountedFare += discFare;

          jeepneyLegsHTML += `<b>Jeepney ${legCount} (Route ${currentRouteId}):</b> ${(currentSegmentDistance / 1000).toFixed(2)} km<br>
                              &nbsp;&nbsp;&nbsp;&nbsp;Regular: ₱${regFare.toFixed(2)} | Disc: ₱${discFare.toFixed(2)}<br><br>`;
          
          legCount++;
          currentRouteId = null;
          currentSegmentDistance = 0;
        }
      }
    }
  }

  if (currentRouteId !== null && currentSegmentDistance > 0) {
    const regFare = fareCalculator(currentSegmentDistance, false);
    const discFare = fareCalculator(currentSegmentDistance, true);
    
    totalTripRegularFare += regFare;
    totalTripDiscountedFare += discFare;

    jeepneyLegsHTML += `<b>Jeepney ${legCount} (Route ${currentRouteId}):</b> ${(currentSegmentDistance / 1000).toFixed(2)} km<br>
                        &nbsp;&nbsp;&nbsp;&nbsp;Regular: ₱${regFare.toFixed(2)} | Disc: ₱${discFare.toFixed(2)}<br><br>`;
  }

  let transferHTML = "";
  transfers.forEach((t, index) => {
    const fromStop = stopById[t.from];
    const toStop = stopById[t.to];
    if (!fromStop || !toStop) return;

    transferHTML += `<b>Transfer ${index + 1}:</b> Walk from <i>${fromStop.name}</i> to <i>${toStop.name}</i><br>`;
  });

  // Construct UI payload with interactive type toggle interface buttons
  document.getElementById("routeInfo").innerHTML = `
    <div style="font-family: sans-serif; line-height: 1.4;">
      <h3 style="margin: 0 0 8px 0; color: #0066ff;"> Active Route Directions</h3>
      
      <div style="display: flex; gap: 10px; margin-bottom: 15px;">
        <button onclick="window.setJeepneyType('traditional')" style="flex: 1; padding: 8px; cursor: pointer; font-weight: bold; border-radius: 4px; border: 1px solid #0066ff; background-color: ${selectedJeepneyType === 'traditional' ? '#0066ff' : '#fff'}; color: ${selectedJeepneyType === 'traditional' ? '#fff' : '#0066ff'};">
          Traditional PUJ
        </button>
        <button onclick="window.setJeepneyType('modern')" style="flex: 1; padding: 8px; cursor: pointer; font-weight: bold; border-radius: 4px; border: 1px solid #0066ff; background-color: ${selectedJeepneyType === 'modern' ? '#0066ff' : '#fff'}; color: ${selectedJeepneyType === 'modern' ? '#fff' : '#0066ff'};">
          Modern Jeepney
        </button>
      </div>

      <b>Origin:</b> ${startStop.name}<br><br>
      <b>Destination:</b> ${bestEndStop.name}<br><br>
      <b>Total Stops:</b> ${path.length} | <b>Total Ride:</b> ${(totalTripDistanceMeters / 1000).toFixed(2)} km
      
      <hr style="border: 0; border-top: 1px solid #ccc; margin: 10px 0;">
      
      <h4 style="margin: 0 0 5px 0; color: #333;"> Fare & Ride Breakdown (${selectedJeepneyType.toUpperCase()})</h4>
      ${jeepneyLegsHTML}
      ${transferHTML ? `<div style="margin-top: 5px; font-size: 0.9em; color: #555;">${transferHTML}</div>` : ""}
      
      <hr style="border: 0; border-top: 1px solid #ccc; margin: 10px 0;">
      
      <h4 style="margin: 0 0 5px 0; color: #d9534f;"> Total Estimated Trip Cost</h4>
      <div style="font-size: 1.1em; background: #f9f9f9; padding: 8px; border-radius: 4px; border-left: 4px solid #d9534f;">
         <b>Regular Total:</b> <span style="font-weight: bold; color: #333;">₱${totalTripRegularFare.toFixed(2)}</span><br>
         <b>Discounted Total:</b> <span style="font-weight: bold; color: #5cb85c;">₱${totalTripDiscountedFare.toFixed(2)}</span>
      </div>
    </div>
  `;


}
// ================= DEBOUNCE =================
function debounce(fn, delay = 400) {
  let timer;
 
  return (...args) => {
    clearTimeout(timer);
 
    timer = setTimeout(() => {
      fn(...args);
    }, delay);
  };
}
 
// ================= SEARCH =================
const input =
  document.getElementById("locationInput");
 
const box =
  document.getElementById("suggestions");
 
input.addEventListener(
  "input",
  debounce(async () => {
    const q = input.value.trim();
 
    if (q.length < 3) {
      box.innerHTML = "";
      return;
    }
 
    const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(
      q
    )}&filter=circle:${icctPosition[1]},${
      icctPosition[0]
    },15000&apiKey=${API_KEY}`;
 
    try {
      const res = await fetch(url);
      const data = await res.json();
 
      renderSuggestions(data.features || []);
    } catch (err) {
      console.error("SEARCH ERROR:", err);
    }
  })
);
 
// ================= RENDER SUGGESTIONS =================
function renderSuggestions(features) {
  box.innerHTML = "";
 
  features.forEach((place) => {
    const div = document.createElement("div");
 
    div.className = "suggestion-item";
 
    div.textContent =
      place.properties.formatted;
 
    div.onclick = async () => {
      stopTracking();
 
      locationMode = "search";
 
      const lat = place.properties.lat;
      const lng = place.properties.lon;

      // REMOVE this

// REPLACE with this:
map.flyToBounds(
  [[lat, lng], icctPosition],
  {
    padding: [60, 60],
    animate: true,
    duration: 1,
  }
);
 
      await processUserLocation(lat, lng);
 
      input.value =
        place.properties.formatted;
 
      box.innerHTML = "";
    };
 
    box.appendChild(div);
  });
}
 
// ================= GPS =================
function startTracking() {
  stopTracking();
 
  let running = false;
 
  watchId = navigator.geolocation.watchPosition(
    async (position) => {
      if (running) return;
 
      running = true;
 
      try {
        const {
          latitude,
          longitude,
          accuracy,
        } = position.coords;
 
        if (accuracy > 50) {
          console.log(
            "Bad GPS accuracy:",
            accuracy
          );
          return;
        }
 
        await processUserLocation(
          latitude,
          longitude
        );
      } catch (err) {
        console.error(
          "PROCESS LOCATION ERROR:",
          err
        );
      } finally {
        running = false;
      }
    },
    (error) => {
      console.error("GPS ERROR:", error);
 
      switch (error.code) {
        case error.PERMISSION_DENIED:
          alert("Location permission denied");
          break;
 
        case error.POSITION_UNAVAILABLE:
          alert("Location unavailable");
          break;
 
        case error.TIMEOUT:
          alert("GPS timeout. Retrying...");
          break;
 
        default:
          alert("Unknown GPS error");
          break;
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 30000,
    }
  );
}
 
function stopTracking() {
  if (watchId) {
    navigator.geolocation.clearWatch(
      watchId
    );
  }
 
  watchId = null;
}
 
// ================= EXPORTS =================
window.startTracking = startTracking;
 
window.stopTracking = stopTracking;
 
window.useCurrentLocation = () => {
  if (!navigator.geolocation) {
    alert("GPS not supported in this browser");
    return;
  }
 
  locationMode = "gps";
 
  stopTracking();
  startTracking();
};



// ================= FULLSCREEN CONTROL =================
const FullscreenControl = L.Control.extend({
  options: { position: "topright" },

  onAdd: function () {
    const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
    const link = L.DomUtil.create("a", "", container);

    link.href = "#";
    link.innerHTML = "⛶";
    link.title = "Toggle Fullscreen";

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