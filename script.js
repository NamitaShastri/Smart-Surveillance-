const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const API_BASE = "http://127.0.0.1:8000";

const ACTIVE_USER_ID = 1;
const ACTIVE_LOCATION_ID = 1;

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`API ${response.status}: ${message}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function formatEventTime(timestamp) {
  if (!timestamp) return "Time unavailable";

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp);

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mapBackendEvent(event) {
  const label = event.person_label || "Unknown person";
  const type = event.event_type || "person_detected";
  const isRecognized = label !== "Unknown person" && !label.startsWith("DEMO CANDIDATE:");

  return {
    id: event.id,
    timestamp: event.timestamp,
    time: formatEventTime(event.timestamp),
    title:
      type === "person_detected"
        ? isRecognized
          ? `${label} detected`
          : "Person detected"
        : type.replaceAll("_", " "),
    detail: event.details || "Person detection event.",
    camera: `Camera ${event.camera_id ?? "Unknown"}`,
    type: "person",
    icon: "♙",
    color: "purple",
    recording: false,
    personLabel: label,
    identityVerified: isRecognized,
  };
}

async function loadBackendEvents({ silent = false } = {}) {
  if (eventsLoading) return;

  eventsLoading = true;
  eventsError = "";

  const timeline = $("#eventTimeline");

  // Don't replace the timeline with a loading screen on every poll.
  if (!silent && timeline) {
    timeline.innerHTML = `
      <div class="empty-state">
        <strong>Loading events…</strong>
        <p>Fetching saved CCTV events.</p>
      </div>
    `;
  }

  // Keep the rest of your existing try/catch/finally code here.

  try {
    const data = await apiRequest(`/locations/${ACTIVE_LOCATION_ID}/events`);

    const rows = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : null;

    if (!rows) {
      throw new Error("Unexpected events response. Check the endpoint response in Swagger.");
    }

    events = rows.map(mapBackendEvent);

    // Newest events first.

    events.sort((a, b) => {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    renderRecent();
    renderEvents();

    const total = $("#overviewEventCount");
    if (total) total.textContent = String(events.length);
  } catch (error) {
    eventsError = error.message;
    console.error("Could not load backend events:", error);

    if (timeline) {
      timeline.innerHTML = `
        <div class="empty-state">
          <strong>Couldn't load CCTV events</strong>
          <p>${escapeHtml(eventsError)}</p>
          <button class="primary-btn" id="retryEventsBtn" type="button">
            Try again
          </button>
        </div>
      `;

      $("#retryEventsBtn")?.addEventListener("click", loadBackendEvents);
    }
  } finally {
    eventsLoading = false;
  }
}

let timelineRefreshTimer = null;

function startTimelineAutoRefresh() {
  if (timelineRefreshTimer !== null) return;

  timelineRefreshTimer = setInterval(() => {
    const eventsPage = $("#page-events");
    const appShell = $("#appShell");

    // Poll only while the Events page is visible.
    if (
      eventsPage?.classList.contains("active") &&
      appShell &&
      !appShell.classList.contains("hidden") &&
      !document.hidden
    ) {
      loadBackendEvents({ silent: true });
    }
  }, 5000);
}

function stopTimelineAutoRefresh() {
  if (timelineRefreshTimer !== null) {
    clearInterval(timelineRefreshTimer);
    timelineRefreshTimer = null;
  }
}

let cameras = [];
let sites = [];
let cameraIdCounter = 5;
let currentUser = { name: "Namita Shastri", email: "Namita@example.com" };
let selectedHour = null,
  localVideoUrl = null,
  toastTimer;
let archiveRecordings = [];
let archiveHours = [];
let knownPeople = [];
let knownPeopleLoading = false;
let events = [];
let eventsLoading = false;
let eventsError = "";
const hours = [
  { start: 0, end: 1, clips: 0, amount: 0 },
  { start: 1, end: 2, clips: 0, amount: 0 },
  { start: 2, end: 3, clips: 0, amount: 0 },
  { start: 6, end: 7, clips: 2, amount: 30 },
  { start: 7, end: 8, clips: 5, amount: 78 },
  { start: 8, end: 9, clips: 3, amount: 52 },
  { start: 9, end: 10, clips: 2, amount: 34 },
  { start: 10, end: 11, clips: 0, amount: 0 },
  { start: 11, end: 12, clips: 0, amount: 0 },
  { start: 12, end: 13, clips: 3, amount: 64 },
  { start: 13, end: 14, clips: 2, amount: 43 },
  { start: 14, end: 15, clips: 0, amount: 0 },
  { start: 15, end: 16, clips: 2, amount: 48 },
  { start: 16, end: 17, clips: 4, amount: 76 },
  { start: 17, end: 18, clips: 5, amount: 90 },
  { start: 18, end: 19, clips: 4, amount: 72 },
  { start: 19, end: 20, clips: 0, amount: 0 },
  { start: 20, end: 21, clips: 0, amount: 0 },
  { start: 21, end: 22, clips: 0, amount: 0 },
  { start: 22, end: 23, clips: 0, amount: 0 },
  { start: 23, end: 24, clips: 0, amount: 0 },
];
function initials(name) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((x) => x[0]?.toUpperCase() || "")
      .join("") || "U"
  );
}
function syncUser() {
  const first = currentUser.name.split(" ")[0] || "there";
  $("#sidebarName").textContent = currentUser.name;
  $("#sidebarEmail").textContent = currentUser.email;
  $("#topName").textContent = currentUser.name;
  $("#sidebarAvatar").textContent = initials(currentUser.name);
  $("#topAvatar").textContent = initials(currentUser.name);
  $("#menuAvatar").textContent = initials(currentUser.name);
  $("#menuName").textContent = currentUser.name;
  $("#menuEmail").textContent = currentUser.email;
  $("#settingsAvatar").textContent = initials(currentUser.name);
  $("#profileNameInput").value = currentUser.name;
  $("#profileEmailInput").value = currentUser.email;
}
function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function goPage(page) {
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  $$("[data-page]").forEach((b) =>
    b.classList.toggle("active", b.classList.contains("nav-item") && b.dataset.page === page),
  );
  $("#pageCrumb").textContent =
    {
      overview: "Overview",
      cameras: "Connect CCTV",
      events: "Events & timeline",
      recordings: "Recording archive",
      settings: "Settings",
      knownpeople: "Known people",
    }[page] || "Overview";
  $("#profileMenu").classList.add("hidden");
  $("#sidebar").classList.remove("mobile-open");
  if (page === "cameras") renderCameras();
  if (page === "knownpeople") loadKnownPeople();
  if (page === "events") loadBackendEvents();
  if (page === "recordings") renderHours();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function loadUserCameraData(email) {
  const key = "sentinel-camera-data:" + email.toLowerCase();
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const data = JSON.parse(saved);
      cameras = Array.isArray(data.cameras) ? data.cameras : [];
      sites = Array.isArray(data.sites) ? data.sites : [];
    } 
    else {
      cameras = [];
      sites = [];
    }
  } catch {
    cameras = [];
    sites = [];
  }
  cameraIdCounter = Math.max(
    1,
    ...cameras.map((c) => Number(String(c.id || "").replace(/\D/g, "")) + 1 || 1),
  );
}
function saveUserCameraData() {
  try {
    localStorage.setItem(
      "sentinel-camera-data:" + currentUser.email.toLowerCase(),
      JSON.stringify({
        cameras: cameras.map(
          ({ name, id, quality, scene, status, location, siteName, siteType, sourceType }) => ({
            name,
            id,
            quality,
            scene,
            status,
            location,
            siteName,
            siteType,
            sourceType,
          }),
        ),
        sites,
      }),
    );
  } catch {
    showToast("Could not save camera list in this browser.");
  }
}
function showApp(user) {
  currentUser = user;
  loadUserCameraData(user.email);
  syncUser();
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  renderCameras();
  goPage("overview");
}
function showAuth() {
  $("#appShell").classList.add("hidden");
  $("#authScreen").classList.remove("hidden");
  $("#profileMenu").classList.add("hidden");
}
function authTab(tab) {
  $$(".auth-tab").forEach((b) => b.classList.toggle("active", b.dataset.auth === tab));
  $("#signinForm").classList.toggle("hidden", tab !== "signin");
  $("#signupForm").classList.toggle("hidden", tab !== "signup");
  $("#authMessage").textContent = "";
  $("#signUpMessage").textContent = "";
}
function renderCameraCard(c, i) {
  const scene = c.scene || "preview-front";
  return `<article class="camera-card"><div class="camera-preview ${scene}"><span class="preview-label"><i class="record-dot"></i> ${c.sourceType === "file" ? "TEST SOURCE" : "DEMO FEED"}</span><span class="camera-overlay">${escapeHtml(c.id)}</span><div class="${scene === "preview-drive" ? "scene-road" : scene === "preview-back" ? "scene-garden" : "scene-door"}"></div></div><div class="camera-info"><div><strong>${escapeHtml(c.name)}</strong><small><span class="${c.status === "online" ? "online-dot" : "offline-dot"}"></span> ${c.status === "online" ? "Online" : "Not connected"} · ${escapeHtml(c.quality || "Quality not checked")} · ${escapeHtml(c.location || c.siteName || "Location not set")}</small><small class="camera-site-label">⌂ ${escapeHtml(c.siteName || "Unassigned")} · ${escapeHtml(c.siteType || "Location")}</small></div><button class="dots-btn camera-more" data-camera-index="${i}">•••</button></div><div class="camera-info camera-extra"><span class="muted" style="font-size:10px">${c.sourceType === "file" ? "Test source only" : "Connection setup pending backend"}</span><button class="text-btn remove-camera-btn" data-remove-camera="${i}">Remove</button></div></article>`;
}
function renderCameras(filter = "all", query = "") {
  const grid = $("#allCamerasGrid");
  if (!grid) return;
  const list = cameras.filter(
    (c) =>
      (filter === "all" || c.status === filter) &&
      `${c.name} ${c.id} ${c.location} ${c.siteName} ${c.siteType}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  $("#cameraEmptyState").classList.toggle("hidden", cameras.length > 0);
  grid.classList.toggle("hidden", cameras.length === 0);
  $("#cameraNavCount").textContent = cameras.length;
  $("#cameraWelcomeTitle").textContent = cameras.length
    ? `Welcome back, ${currentUser.name.split(" ")[0]}`
    : "Welcome to your security workspace";
  $("#cameraWelcomeText").textContent = cameras.length
    ? `${cameras.length} camera${cameras.length === 1 ? "" : "s"} listed across ${sites.length} location${sites.length === 1 ? "" : "s"}. Connection status is demo data until the backend is connected.`
    : "Start by adding a location and connecting your first CCTV. You can manage home, office, shop, and other sites from this page.";
  renderSites();
  grid.innerHTML = list.map(renderCameraCard).join("");
  if (cameras.length && list.length === 0)
    grid.innerHTML =
      '<div class="empty-state"><strong>No cameras match</strong><p>Try another search or filter.</p></div>';
  $$(".remove-camera-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.removeCamera);
      if (!Number.isNaN(i)) {
        const name = cameras[i]?.name;
        cameras.splice(i, 1);
        saveUserCameraData();
        renderCameras();
        showToast(`${name || "Camera"} removed from this demo list.`);
      }
    }),
  );
  $$(".camera-more").forEach((b) =>
    b.addEventListener("click", () => {
      const c = cameras[Number(b.dataset.cameraIndex)];
      if (c)
        openModal(
          "Camera details",
          `<p><strong>${escapeHtml(c.name)}</strong></p><p>Location: ${escapeHtml(c.siteName || "Unassigned")} · ${escapeHtml(c.siteType || "Location")}</p><p>Source: ${escapeHtml(c.sourceType || "Not configured")}</p><p>Actual camera connection will be verified by the backend in a later phase.</p><button class="primary-btn close-modal-action" type="button">Close</button>`,
        );
    }),
  );
}
function renderSites() {
  const wrap = $("#cameraSites");
  if (!wrap) return;
  if (!sites.length) {
    wrap.innerHTML = "";
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  wrap.innerHTML = sites
    .map((site, index) => {
      const cams = cameras.filter((c) => c.siteName === site.name);
      return `<article class="site-card"><div class="site-card-top"><div class="site-icon">${site.type === "Office" ? "▥" : site.type === "Shop" ? "▣" : site.type === "Warehouse" ? "▤" : "⌂"}</div><div class="site-title"><strong>${escapeHtml(site.name)}</strong><span>${escapeHtml(site.type)} · ${cams.length} camera${cams.length === 1 ? "" : "s"}</span></div><button class="site-add-camera text-btn" data-site-index="${index}">＋ Add camera</button></div><div class="site-camera-summary">${cams.length ? cams.map((c) => `<span class="site-camera-chip"><i class="${c.status === "online" ? "online-dot" : "offline-dot"}"></i>${escapeHtml(c.name)}</span>`).join("") : '<span class="muted">No cameras added at this location yet.</span>'}</div></article>`;
    })
    .join("");
  $$(".site-add-camera").forEach((b) =>
    b.addEventListener("click", () =>
      openAddCameraModal(sites[Number(b.dataset.siteIndex)]?.name || ""),
    ),
  );
}
function openAddCameraModal(preselectedSite = "") {
  const siteOptions = sites
    .map(
      (s) =>
        `<option value="${escapeHtml(s.name)}" ${s.name === preselectedSite ? "selected" : ""}>${escapeHtml(s.name)} (${escapeHtml(s.type)})</option>`,
    )
    .join("");
  openModal(
    "Add CCTV",
    `<p class="modal-intro">Register a camera for a home, office, shop, or other location. This demo saves its label only; it does not connect to the live stream yet.</p><form id="connectCameraForm" class="connect-camera-form"><label>Camera name<input id="newCameraName" required maxlength="60" placeholder="e.g. Reception camera"></label><label>Location<select id="newCameraSite" required>${siteOptions || '<option value="">Add a location first</option>'}</select></label><label>Connection method<select id="newCameraType"><option value="rtsp">IP camera / DVR / NVR (RTSP)</option><option value="file">Local video test source</option><option value="agent">Local agent (future)</option></select></label><label>Camera area<input id="newCameraArea" placeholder="e.g. Front entrance" maxlength="80"></label><div class="notice-strip"><span class="notice-icon">ⓘ</span><div><strong>Connection not tested yet</strong><p>We will add secure stream setup and connection testing with the backend. Do not enter camera passwords in this prototype.</p></div></div><button class="primary-btn full-btn" type="submit">Save camera details <span>→</span></button><p id="connectCameraMessage" class="auth-message" role="status"></p></form>`,
  );
  const form = $("#connectCameraForm");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#newCameraName").value.trim(),
      siteName = $("#newCameraSite").value,
      sourceType = $("#newCameraType").value,
      area = $("#newCameraArea").value.trim();
    if (!name || !siteName) {
      $("#connectCameraMessage").textContent = "Add a location first, then enter a camera name.";
      return;
    }
    const site = sites.find((s) => s.name === siteName);
    cameras.push({
      name,
      id: `CAM ${String(cameraIdCounter++).padStart(2, "0")}`,
      quality: sourceType === "file" ? "Test source" : "Pending",
      scene: "preview-front",
      status: "offline",
      location: area || siteName,
      siteName,
      siteType: site?.type || "Location",
      sourceType,
    });
    saveUserCameraData();
    $("#modalBackdrop").classList.add("hidden");
    renderCameras();
    showToast(`${name} added to ${siteName}. Live connection is not active yet.`);
  });
}
function openAddSiteModal() {
  openModal(
    "Add a location",
    `<p>Create a separate space for each property or business site.</p><form id="addSiteForm" class="connect-camera-form"><label>Location name<input id="newSiteName" required maxlength="60" placeholder="e.g. City Office"></label><label>Location type<select id="newSiteType"><option>Home</option><option>Office</option><option>Shop</option><option>Warehouse</option><option>Other</option></select></label><button class="primary-btn full-btn" type="submit">Create location <span>→</span></button><p id="addSiteMessage" class="auth-message" role="status"></p></form>`,
  );
  $("#addSiteForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#newSiteName").value.trim(),
      type = $("#newSiteType").value;
    if (!name) return;
    if (sites.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      $("#addSiteMessage").textContent = "A location with this name already exists.";
      return;
    }
    sites.push({ name, type });
    saveUserCameraData();
    $("#modalBackdrop").classList.add("hidden");
    renderCameras();
    showToast(`${name} location added.`);
  });
}

function eventMarkup(e, compact = false) {
  return `<div class="${compact ? "event-row" : "timeline-item"}">${compact ? `<div class="event-symbol ${e.color}">${e.icon}</div><div class="event-row-main"><strong>${e.title}</strong><p>${e.camera} · ${e.detail}</p></div><span class="event-time">${e.time}</span>` : `<div class="timeline-time">${e.time}</div><div class="timeline-rail"><span class="timeline-dot ${e.color}">${e.icon}</span></div><div class="timeline-content"><div><strong>${e.title}</strong><p>${e.detail}</p><div class="timeline-tags"><span class="timeline-tag">▣ ${e.camera}</span><span class="timeline-tag">${e.type === "person" ? "Person detection" : e.type === "delivery" ? "Delivery" : e.type === "arrival" ? "Arrival / departure" : "Motion detection"}</span></div></div>${e.recording ? `<button class="timeline-recording" data-event-time="${e.time}" data-event-camera="${e.camera}">▶ View footage</button>` : ""}</div>`}</div>`;
}
function renderRecent() {
  $("#recentEvents").innerHTML = events
    .slice(0, 4)
    .map((e) => eventMarkup(e, true))
    .join("");
}
function renderEvents() {
  const q = ($("#eventSearch")?.value || "").toLowerCase(),
    type = $("#eventTypeFilter")?.value || "all";
  const filtered = events.filter(
    (e) =>
      (type === "all" || e.type === type) &&
      `${e.title} ${e.detail} ${e.camera}`.toLowerCase().includes(q),
  );
  $("#eventTimeline").innerHTML = filtered.map((e) => eventMarkup(e, false)).join("");
  $("#eventCount").textContent = `${filtered.length} event${filtered.length === 1 ? "" : "s"}`;
  $("#noEvents").classList.toggle("hidden", filtered.length > 0);
  const date = $("#eventDateFilter").value;
  if (date) {
    const d = new Date(date + "T12:00:00");
    $("#timelineDateTitle").textContent = d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    $(".date-marker").textContent = d.getDate();
  }
  $$(".timeline-recording").forEach((b) =>
    b.addEventListener("click", () => {
      goPage("recordings");
      $("#archiveCamera").value = b.dataset.eventCamera;
      $("#playCamera").textContent = b.dataset.eventCamera;
      const [h] = b.dataset.eventTime.split(":").map(Number);
      const idx = hours.findIndex((x) => x.start === h);
      selectHour(idx >= 0 ? idx : hours.findIndex((x) => x.clips > 0));
    }),
  );
}
function hourLabel(h) {
  const fmt = (n) => `${String(n % 24).padStart(2, "0")}:00`;
  return `${fmt(h.start)} – ${fmt(h.end)}`;
}

async function renderHours() {
    const date = $("#archiveDate").value;
    if (!date) {
      $("#hourlyList").innerHTML = `
        <div class="empty-state">
          <strong>Select a date</strong>
          <p>Choose a date to view available recordings.</p>
        </div>`;
      return;
    }

    const list = $("#hourlyList");
    list.innerHTML = `<p>Loading saved recordings...</p>`;

    try {
        const response = await fetch(`${API_BASE}/recordings`);

        if (!response.ok) {
            throw new Error(`API returned ${response.status}`);
        }

        archiveRecordings = await response.json();

        // Keep recordings belonging to the selected calendar date.
        const dailyRecordings = archiveRecordings.filter(recording => {
            const recordingDate = new Date(recording.modified_at);
            const year = recordingDate.getFullYear();
            const month = String(recordingDate.getMonth() + 1).padStart(2, "0");
            const day = String(recordingDate.getDate()).padStart(2, "0");

            return `${year}-${month}-${day}` === date;
        });

        // Group saved files by their actual modification hour.
        const grouped = new Map();

        dailyRecordings.forEach(recording => {
            const recordingDate = new Date(recording.modified_at);
            const hour = recordingDate.getHours();

            if (!grouped.has(hour)) {
                grouped.set(hour, []);
            }

            grouped.get(hour).push(recording);
        });

        archiveHours = [...grouped.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([hour, recordings]) => ({
                hour,
                recordings,
                clips: recordings.length,
                amount: 100,
                label: new Date(2000, 0, 1, hour).toLocaleTimeString(
                    "en-US",
                    { hour: "numeric", hour12: true }
                )
            }));

        $("#archiveSummaryText").textContent =
            `${dailyRecordings.length} saved recording(s) · real archive`;

        if (archiveHours.length === 0) {
            list.innerHTML = `
                <p>No saved recordings for ${date}.</p>
            `;

            $("#videoStage").innerHTML = `
                <div class="video-placeholder">
                    <span class="play-large">—</span>
                    <strong>No saved footage</strong>
                    <p>Choose a date that has recordings.</p>
                </div>
            `;

            $("#playLocalBtn").disabled = true;
            return;
        }

        list.innerHTML = archiveHours.map((h, i) => `
            <button
                class="hour-row ${selectedHour === i ? "selected" : ""}"
                data-hour-index="${i}"
            >
                <span class="hour-label">${h.label}</span>
                <span class="hour-bar">
                    <span style="width: 100%"></span>
                </span>
                <span class="clip-count">${h.clips}</span>
            </button>
        `).join("");

        list.querySelectorAll(".hour-row").forEach(button => {
            button.addEventListener("click", () => {
                selectHour(Number(button.dataset.hourIndex));
            });
        });

        // Select the first available hour when the previous selection
        // doesn't exist for this date.
        if (!archiveHours[selectedHour]) {
            selectedHour = 0;
        }

        selectHour(selectedHour);

    } catch (error) {
        console.error("Failed to load archive recordings:", error);

        $("#archiveSummaryText").textContent =
            "Unable to load recordings";

        list.innerHTML = `
            <p>Couldn't load saved recordings. Check that the backend is running.</p>
        `;
    }
}



function selectHour(index) {
  selectedHour = index;

  const h = archiveHours[index];
  if (!h) return;

  const cam = $("#archiveCamera").value;
  const stage = $("#videoStage");

  $("#playCamera").textContent = cam;
  $("#playHour").textContent = h.label;
  $("#playbackSubhead").textContent = `${h.label} · ${cam}`;

  $("#playLocalBtn").disabled = !h.recordings.length;

  document.querySelectorAll(".hour-row").forEach((button, i) => {
    button.classList.toggle("selected", i === index);
  });

  const recording = h.recordings[0];

  if (!recording) {
    stage.innerHTML = `
      <div class="video-placeholder">
        <span class="play-large">—</span>
        <strong>No saved footage</strong>
        <p>No recording is available for this hour.</p>
      </div>
    `;
    return;
  }


  // const videoUrl =
  // `${API_BASE}${recording.playback_url}?t=${Date.now()}`;

  stage.innerHTML = `
    <div class="video-placeholder">
      <span class="play-large">▶</span>
      <strong>${recording.filename}</strong>
      <p>Press Play preview to watch this recording.</p>
    </div>
  `;
}


function exportCsv() {
  const rows = [
    ["Time", "Event", "Camera", "Type", "Details"],
    ...events.map((e) => [e.time, e.title, e.camera, e.type, e.detail]),
  ];
  const csv = rows
    .map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "sentinel-events.csv";
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`${events.length} events exported to CSV.`);
}
function openModal(title, body) {
  $("#modalContent").innerHTML = `<h2>${title}</h2>${body}`;
  $("#modalBackdrop").classList.remove("hidden");
}
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

function renderKnownPeople() {
  const list = $("#knownPeopleList");
  if (!list) return;

  $("#knownPeopleCount").textContent =
    `${knownPeople.length} ${knownPeople.length === 1 ? "person" : "people"} enrolled.`;

  if (!knownPeople.length) {
    list.innerHTML = `
      <div class="empty-state">
        <span>♙</span>
        <strong>No enrolled profiles</strong>
        <p>Enroll a consenting person to create a saved face profile.</p>
      </div>`;
    return;
  }

  list.innerHTML = knownPeople
    .map(
      (person) => `
    <article class="known-person-card">
      <div class="known-person-copy">
        <strong>${escapeHtml(person.display_name)}</strong>
        <span>${escapeHtml(person.relationship_label || "Person")}</span>
        <small>
          ${Number(person.sample_count) || 0} face samples saved ·
          ${person.is_active !== false ? "Active profile" : "Inactive profile"}
        </small>
      </div>
      <button
  type="button"
  class="delete-person-btn"
  data-delete-profile="${person.id ?? person.profile_id ?? ""}"
  aria-label="Delete face profile"
>×</button>
    </article>
  `,
    )
    .join("");
}

async function loadKnownPeople() {
  const list = $("#knownPeopleList");
  const message = $("#knownPersonMessage");

  if (knownPeopleLoading) return;
  knownPeopleLoading = true;

  if (list) {
    list.innerHTML = `
      <div class="empty-state">
        <strong>Loading saved profiles…</strong>
        <p>Connecting to Sentinel.</p>
      </div>`;
  }

  try {
    const data = await apiRequest(`/face-profiles/${ACTIVE_USER_ID}`);

    knownPeople = Array.isArray(data) ? data : Array.isArray(data?.profiles) ? data.profiles : null;

    if (!knownPeople) {
      throw new Error("Unexpected response format from the face-profile endpoint.");
    }

    renderKnownPeople();
  } catch (error) {
    console.error("Could not load face profiles:", error);

    if (list) {
      list.innerHTML = `
        <div class="empty-state">
          <strong>Couldn't load saved profiles</strong>
          <p>${escapeHtml(error.message)}</p>
          <button class="secondary-btn" id="retryProfilesBtn"
            type="button">Try again</button>
        </div>`;

      $("#retryProfilesBtn")?.addEventListener("click", loadKnownPeople);
    }
  } finally {
    knownPeopleLoading = false;
  }
}

async function enrollKnownPerson(event) {
  event.preventDefault();

  const message = $("#knownPersonMessage");
  const submitButton = $("#knownPersonForm button[type='submit']");

  const name = $("#knownPersonName").value.trim();
  const relation = $("#knownPersonRelation").value;
  const straight = $("#faceStraight").files[0];
  const left = $("#faceLeft").files[0];
  const right = $("#faceRight").files[0];
  const consent = $("#faceConsent").checked;

  if (!name || !straight || !left || !right || !consent) {
    message.textContent = "Enter a name, select all three images, and confirm consent.";
    return;
  }

  const files = [straight, left, right];
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

  if (files.some((file) => !allowedTypes.includes(file.type))) {
    message.textContent = "Use JPEG, PNG, or WebP images for all three angles.";
    return;
  }

  const maxBytes = 8 * 1024 * 1024;

  if (files.some((file) => file.size > maxBytes)) {
    message.textContent = "Each image must be 8 MB or smaller.";
    return;
  }

  const formData = new FormData();
  formData.append("display_name", name);
  formData.append("relationship_label", relation);
  formData.append("consent_given", "true");
  formData.append("source", "live_capture");
  formData.append("straight_image", straight);
  formData.append("left_image", left);
  formData.append("right_image", right);

  submitButton.disabled = true;
  message.textContent = "Enrolling face profile…";

  try {
    const result = await apiRequest(`/face-profiles/${ACTIVE_USER_ID}/enroll-multi`, {
      method: "POST",
      body: formData,
    });

    message.textContent = result.message || "Face profile enrolled successfully.";

    $("#knownPersonForm").reset();

    showToast(`${name} enrolled successfully.`);
    await loadKnownPeople();
  } catch (error) {
    console.error("Face enrollment failed:", error);
    message.textContent = `Enrollment failed: ${error.message}`;
  } finally {
    submitButton.disabled = false;
  }
}

async function deleteKnownPerson(profileId) {
  if (!profileId) {
    console.error("Delete failed: missing profile ID.");
    return;
  }

  if (!confirm("Are you sure you want to remove this person's face profile?")) {
    return;
  }

  try {
    await apiRequest(`/face-profiles/${ACTIVE_USER_ID}/${encodeURIComponent(profileId)}`, {
      method: "DELETE",
    });

    showToast("Face profile deleted.");
    await loadKnownPeople();
  } catch (error) {
    console.error("Delete failed:", error);
    showToast("Could not delete face profile. Check the console.");
  }
}

function init() {
  $$(".auth-tab").forEach((b) => b.addEventListener("click", () => authTab(b.dataset.auth)));
  $$(".show-password").forEach((b) =>
    b.addEventListener("click", () => {
      const input = $("#" + b.dataset.target);
      input.type = input.type === "password" ? "text" : "password";
      b.textContent = input.type === "password" ? "Show" : "Hide";
    }),
  );
  $("#signInBtn").addEventListener("click", () => {
    const email = $("#signInEmail").value.trim(),
      pass = $("#signInPassword").value;
    if (!email || !pass) {
      $("#authMessage").textContent = "Enter your email and password to continue.";
      return;
    }
    const name = email
      .split("@")[0]
      .split(/[._-]/)
      .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : ""))
      .join(" ");
    showApp({ name: name || "User", email });
    showToast(
      cameras.length
        ? "Your saved camera list is ready."
        : "Welcome! Connect your first CCTV to get started.",
    );
  });
  $("#signUpBtn").addEventListener("click", () => {
    const name = $("#signUpName").value.trim(),
      email = $("#signUpEmail").value.trim(),
      pass = $("#signUpPassword").value;
    if (!name || !email || !pass) {
      $("#signUpMessage").textContent = "Please complete all fields.";
      return;
    }
    if (pass.length < 6) {
      $("#signUpMessage").textContent = "Use at least 6 characters for this demo.";
      return;
    }
    cameras = [];
    sites = [];
    showApp({ name, email });
    showToast("Welcome! Add a location, then connect your first CCTV.");
  });
  $("#forgotLink").addEventListener("click", (e) => {
    e.preventDefault();
    openModal(
      "Password reset",
      '<p>Password reset is not connected in this frontend prototype. A backend email flow can be added with real authentication.</p><button class="primary-btn close-modal-action" type="button">Got it</button>',
    );
  });
  $("#authThemeBtn").addEventListener("click", () => document.body.classList.toggle("light"));
  $("#themeBtn").addEventListener("click", () => {
    document.body.classList.toggle("light");
    showToast(
      document.body.classList.contains("light") ? "Light mode enabled" : "Dark mode enabled",
    );
  });
  $("#profileBtn").addEventListener("click", () => $("#profileMenu").classList.toggle("hidden"));
  $("#sidebarUserMenuBtn").addEventListener("click", () =>
    $("#profileMenu").classList.toggle("hidden"),
  );
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".profile-wrap") && !e.target.closest("#sidebarUserMenuBtn"))
      $("#profileMenu").classList.add("hidden");
  });
  $$("[data-page]").forEach((b) => b.addEventListener("click", () => goPage(b.dataset.page)));
  $("#signOutBtn").addEventListener("click", () => {
    showAuth();
    authTab("signin");
    $("#signInPassword").value = "";
    showToast("Signed out of the demo workspace.");
  });
  $("#addCameraBtn").addEventListener("click", () => {
    if (!sites.length) {
      openAddSiteModal();
      showToast("Create a location first, then add a CCTV camera.");
      return;
    }
    openAddCameraModal();
  });
  $("#emptyAddCameraBtn").addEventListener("click", () => {
    if (!sites.length) openAddSiteModal();
    else openAddCameraModal();
  });
  $("#addSiteBtn").addEventListener("click", openAddSiteModal);
  $("#eventSearch").addEventListener("input", renderEvents);
  $("#eventTypeFilter").addEventListener("change", renderEvents);
  $("#eventDateFilter").addEventListener("change", renderEvents);
  $("#exportEventsBtn").addEventListener("click", exportCsv);
  $("#archiveCamera").addEventListener("change", () => {
    selectedHour = null;
    $("#playCamera").textContent = $("#archiveCamera").value;
    $("#playHour").textContent = "—";
    $("#videoStage").innerHTML =
      '<div class="video-placeholder"><span class="play-large">▶</span><strong>No hour selected</strong><p>Choose an available hour from the archive.</p></div>';
    renderHours();
  });
  $("#archiveDate").addEventListener("change", () => {
    selectedHour = null;
    $("#playHour").textContent = "—";
    $("#videoStage").innerHTML =
      '<div class="video-placeholder"><span class="play-large">▶</span><strong>No hour selected</strong><p>Choose an available hour from the archive.</p></div>';
    renderHours();
  });
  $("#recordingType").addEventListener("change", () =>
    showToast("Recording type filter is a UI demo; no real archive is connected."),
  );
  
  $("#downloadInfoBtn").addEventListener("click", () => {
  const hour = archiveHours[selectedHour];
  const recording = hour?.recordings?.[0];

  if (!recording) {
    showToast("Select an hour with a saved recording first.");
    return;
  }

  openModal(
    "Recording details",
    `
      <p><strong>File:</strong> ${escapeHtml(recording.filename || "Recording")}</p>
      <p><strong>Date:</strong> ${escapeHtml($("#archiveDate").value || "—")}</p>
      <p><strong>Hour:</strong> ${escapeHtml(hourLabel(hour))}</p>
      <p><strong>Status:</strong> Recording metadata available</p>
      <button class="primary-btn close-modal-action" type="button">
        Close details
      </button>
    `
  );
});
  $("#closeModal").addEventListener("click", () => $("#modalBackdrop").classList.add("hidden"));
  $("#modalContent").addEventListener("click", (e) => {
    if (e.target.closest(".close-modal-action")) $("#modalBackdrop").classList.add("hidden");
  });
  $("#modalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "modalBackdrop") $("#modalBackdrop").classList.add("hidden");
  });
  $("#profileForm").addEventListener("submit", (e) => {
    e.preventDefault();
    currentUser.name = $("#profileNameInput").value.trim() || "User";
    currentUser.email = $("#profileEmailInput").value.trim();
    syncUser();
    $("#settingsMessage").textContent = "Profile updated in this demo session.";
    showToast("Profile details updated.");
  });
  $("#knownPersonForm").addEventListener("submit", enrollKnownPerson);
  $("#securityTab").addEventListener("click", () =>
    openModal(
      "Sign-in & security",
      "<p>Real password changes, two-factor authentication, and session management will be available after a secure backend is connected.</p>",
    ),
  );
  $("#preferencesTab").addEventListener("click", () =>
    openModal(
      "Preferences",
      "<p>Theme preference currently applies in this browser session. Notification, retention, and recording preferences can be wired to the backend later.</p>",
    ),
  );
  $("#profileHelpBtn").addEventListener("click", () =>
    openModal(
      "Help & support",
      "<p>This is a frontend prototype. For setup help, review the README included with the project files.</p>",
    ),
  );
  $("#notificationBtn").addEventListener("click", () =>
    showToast("You’re all caught up in this demo."),
  );
  $("#knownPeopleList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-profile]");
    if (!button) return;

    const profileId = Number(button.dataset.deleteProfile);

    if (!Number.isInteger(profileId) || profileId <= 0) {
      console.error("Invalid profile ID:", button.dataset.deleteProfile, button);
      showToast("Could not identify this profile. Refresh the list.");
      return;
    }

    deleteKnownPerson(profileId);
  });
  renderRecent();
  renderCameras();
  renderHours();
  loadBackendEvents();
  startTimelineAutoRefresh();


  $("#playLocalBtn").addEventListener("click", async () => {
  const hour = archiveHours[selectedHour];
  const recording = hour?.recordings?.[0];

  if (!recording?.playback_url) {
    showToast("No playable recording is available for this hour.");
    return;
  }

  const stage = $("#videoStage");
  stage.innerHTML = `
    <video controls autoplay playsinline
      style="width:100%;height:100%;object-fit:contain">
    </video>`;

  const video = stage.querySelector("video");
  video.src = `${API_BASE}${recording.playback_url}?t=${Date.now()}`;

  video.addEventListener("error", () => {
    showToast("Playback failed. Check the video format and backend URL.");
  }, { once: true });
});
}
document.addEventListener("DOMContentLoaded", init);