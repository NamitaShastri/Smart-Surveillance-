const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const API_BASE = window.SENTINEL_API_BASE || "http://127.0.0.1:8000";


let authToken = null;

async function apiRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!response.ok) {
    if (response.status === 401 && authToken) {
      endSession();
      showToast("Your session expired. Please sign in again.");
    }
    const raw = await response.text();
    let message = raw;
    try {
      const detail = JSON.parse(raw).detail;
      message = Array.isArray(detail) ? detail.map((d) => d.msg).join("; ") : detail || raw;
    } catch {}
    const error = new Error(message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
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





let timelineRefreshTimer = null;



function stopTimelineAutoRefresh() {
  if (timelineRefreshTimer !== null) {
    clearInterval(timelineRefreshTimer);
    timelineRefreshTimer = null;
  }
}

let cameras = [];
let sites = [];
let currentUser = { id: null, name: "", email: "" };
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
  if (page !== "knownpeople") stopLiveCamera();
  if (page === "knownpeople") loadKnownPeople();
  if (page === "events") loadBackendEvents();
  if (page === "recordings") renderHours();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
    const cameraId = Number($("#archiveCamera").value);
    if (!cameraId) {
      list.innerHTML = `<p>Add a camera first to browse its recordings.</p>`;
      $("#archiveSummaryText").textContent = "No cameras";
      return;
    }
    list.innerHTML = `<p>Loading saved recordings...</p>`;

    try {
        archiveRecordings = await apiRequest(`/recordings?camera_id=${cameraId}`);

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

  const cam = $("#archiveCamera").selectedOptions[0]?.textContent || "";
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
    const data = await apiRequest(`/face-profiles/${currentUser.id}`);

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

/* ---------- face enrollment: live webcam or photo upload ---------- */
const POSES = [
  { key: "straight", label: "Straight", hint: "Look straight at the camera and keep your face centred." },
  { key: "left", label: "Left", hint: "Turn your head slightly to your left, keeping your face visible." },
  { key: "right", label: "Right", hint: "Turn your head slightly to your right, keeping your face visible." },
];
let enrollMode = "live";
let liveStream = null;
let livePose = 0;
const liveShots = { straight: null, left: null, right: null }; // { file, url }

function setEnrollMode(mode) {
  enrollMode = mode;
  $$("[data-enroll-mode]").forEach((b) => {
    const on = b.dataset.enrollMode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("#enrollLive").classList.toggle("hidden", mode !== "live");
  $("#enrollUpload").classList.toggle("hidden", mode !== "upload");
  if (mode !== "live") stopLiveCamera();
  $("#knownPersonMessage").textContent = "";
}

function renderLive() {
  POSES.forEach((p, i) => {
    const el = $(`.live-step[data-pose="${p.key}"]`);
    el.classList.toggle("active", i === livePose);
    el.classList.toggle("done", Boolean(liveShots[p.key]));
    $(".live-thumb", el).innerHTML = liveShots[p.key] ? `<img src="${liveShots[p.key].url}" alt="${p.label} capture">` : "";
  });
  const pose = POSES[livePose];
  $("#livePoseHint").textContent = pose.hint;
  $("#liveCaptureBtn").textContent = `${liveShots[pose.key] ? "Retake" : "Capture"} ${pose.label.toLowerCase()}`;
  $("#liveCaptureBtn").disabled = !liveStream;
  $("#liveStopBtn").disabled = !liveStream;
  $("#liveCount").textContent = `Captured ${POSES.filter((p) => liveShots[p.key]).length} of 3`;
}

function resetLiveShots() {
  POSES.forEach((p) => {
    if (liveShots[p.key]) URL.revokeObjectURL(liveShots[p.key].url);
    liveShots[p.key] = null;
  });
  livePose = 0;
  renderLive();
}

function stopLiveCamera() {
  liveStream?.getTracks().forEach((t) => t.stop());
  liveStream = null;
  const video = $("#liveVideo");
  if (video) video.srcObject = null;
  $("#liveOff")?.classList.remove("hidden");
  renderLive();
}

async function startLiveCamera() {
  const message = $("#knownPersonMessage");
  if (!navigator.mediaDevices?.getUserMedia) {
    message.textContent = "This browser can't access a webcam here. Open the dashboard from localhost or HTTPS, or use Upload photos.";
    return;
  }
  try {
    stopLiveCamera();
    const id = $("#liveCameraSelect").value;
    const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
    liveStream = await navigator.mediaDevices.getUserMedia({
      video: id ? { deviceId: { exact: id }, ...size } : { facingMode: "user", ...size },
      audio: false,
    });
    const video = $("#liveVideo");
    video.srcObject = liveStream;
    await video.play();
    $("#liveOff").classList.add("hidden");
    message.textContent = "";
    // Device names are only available once permission has been granted.
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const select = $("#liveCameraSelect");
    const chosen = select.value;
    select.innerHTML =
      '<option value="">Default camera</option>' +
      devices.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Camera ${i + 1}`)}</option>`).join("");
    select.value = [...select.options].some((o) => o.value === chosen) ? chosen : "";
    renderLive();
  } catch (error) {
    liveStream = null;
    renderLive();
    message.textContent = `Could not start the webcam: ${error.message}. Allow camera permission, or use Upload photos.`;
  }
}

async function captureLive() {
  const video = $("#liveVideo");
  if (!liveStream || !video.videoWidth) {
    $("#knownPersonMessage").textContent = "Wait for the webcam image to appear, then capture.";
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) {
    $("#knownPersonMessage").textContent = "Could not capture the image. Please try again.";
    return;
  }
  const key = POSES[livePose].key;
  if (liveShots[key]) URL.revokeObjectURL(liveShots[key].url);
  liveShots[key] = { file: new File([blob], `webcam_${key}.jpg`, { type: "image/jpeg" }), url: URL.createObjectURL(blob) };
  const next = POSES.findIndex((p) => !liveShots[p.key]);
  if (next >= 0) livePose = next; // jump to the next pose that still needs a capture
  $("#knownPersonMessage").textContent = next >= 0 ? `Saved. Next: ${POSES[next].label.toLowerCase()}.` : "All three captured. Check the previews, then enroll.";
  renderLive();
}

function getEnrollFiles() {
  if (enrollMode === "live") {
    return { straight: liveShots.straight?.file, left: liveShots.left?.file, right: liveShots.right?.file, source: "live_capture" };
  }
  return {
    straight: $("#faceStraight").files[0],
    left: $("#faceLeft").files[0],
    right: $("#faceRight").files[0],
    source: "upload",
  };
}

async function enrollKnownPerson(event) {
  event.preventDefault();

  const message = $("#knownPersonMessage");
  const submitButton = $("#knownPersonForm button[type='submit']");

  const name = $("#knownPersonName").value.trim();
  const relation = $("#knownPersonRelation").value;
  const { straight, left, right, source } = getEnrollFiles();
  const consent = $("#faceConsent").checked;

  if (!name || !straight || !left || !right || !consent) {
    message.textContent = enrollMode === "live"
      ? "Enter a name, capture all three poses, and confirm consent."
      : "Enter a name, choose all three photos, and confirm consent.";
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
  formData.append("source", source);
  formData.append("straight_image", straight);
  formData.append("left_image", left);
  formData.append("right_image", right);

  submitButton.disabled = true;
  message.textContent = "Enrolling face profile…";

  try {
    const result = await apiRequest(`/face-profiles/${currentUser.id}/enroll-multi`, {
      method: "POST",
      body: formData,
    });

    message.textContent = result.message || "Face profile enrolled successfully.";

    $("#knownPersonForm").reset();
    stopLiveCamera();
    resetLiveShots();

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
    await apiRequest(`/face-profiles/${currentUser.id}/${encodeURIComponent(profileId)}`, {
      method: "DELETE",
    });

    showToast("Face profile deleted.");
    await loadKnownPeople();
  } catch (error) {
    console.error("Delete failed:", error);
    showToast("Could not delete face profile. Check the console.");
  }
}

/* ---------- helpers, session and workspace loading ---------- */
const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const postJson = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const isOnline = (c) =>
  ["online", "active", "connected", "running"].includes(String(c.status || "").toLowerCase());
const camLabel = (c) => `CAM ${String(c.id).padStart(2, "0")}`;
const maskSource = (s) => String(s || "Not set").replace(/\/\/[^/@]*@/, "//•••@");
const SCENES = ["preview-drive", "preview-front", "preview-back"];
const sceneOf = (i) => SCENES[i % SCENES.length];

async function loadWorkspace() {
  const locs = await apiRequest(`/users/${currentUser.id}/locations`);
  sites = locs.map((l) => ({ id: l.id, name: l.name, address: l.address, type: l.type || "Other" }));
  const lists = await Promise.all(sites.map((s) => apiRequest(`/locations/${s.id}/cameras`)));
  cameras = lists.flatMap((list, i) =>
    list.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      source: c.source,
      siteId: sites[i].id,
      siteName: sites[i].name,
      siteType: sites[i].type,
    })),
  );
}

async function refreshWorkspace() {
  try {
    await loadWorkspace();
  } catch (error) {
    console.error("Could not load workspace:", error);
    showToast("Couldn't load your locations. Is the backend running?");
  }
  renderCameras();
  fillArchiveCameras();
  await Promise.all([loadBackendEvents({ silent: true }), loadRecordingCount(), checkHealth()]);
  renderOverview();
}

async function checkHealth() {
  let ok = false;
  try {
    await apiRequest("/health");
    ok = true;
  } catch {}
  $("#sysStatusText").textContent = ok ? "Backend online" : "Backend unreachable";
  $("#statBackend").textContent = ok ? "Online" : "Offline";
}

async function loadRecordingCount() {
  try {
    const list = await apiRequest("/recordings");
    $("#statRecs").textContent = Array.isArray(list) ? list.length : 0;
  } catch {
    $("#statRecs").textContent = "—";
  }
}

function fillArchiveCameras() {
  const sel = $("#archiveCamera");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = cameras.length
    ? cameras.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")
    : '<option value="">No cameras yet</option>';
  if (cameras.some((c) => String(c.id) === prev)) sel.value = prev;
  $("#playCamera").textContent = sel.selectedOptions[0]?.textContent || "—";
}

function renderOverview() {
  const now = new Date();
  const first = (currentUser.name || "").split(" ")[0];
  const part = now.getHours() < 12 ? "morning" : now.getHours() < 17 ? "afternoon" : "evening";
  $("#greetingText").textContent = `Good ${part}${first ? ", " + first : ""}`;
  $("#todayLabel").textContent = now
    .toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    .toUpperCase();

  const online = cameras.filter(isOnline).length;
  $("#statCams").textContent = cameras.length;
  $("#statCamsSub").textContent = `/ ${online} online`;
  $("#statCamsFoot").textContent = !cameras.length
    ? "No cameras yet"
    : online === cameras.length
      ? "● All connected"
      : `● ${cameras.length - online} not connected`;
  $("#statSites").textContent = `${sites.length} location${sites.length === 1 ? "" : "s"}`;

  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 864e5));
  const todayCount = events.filter((e) => dayKey(e.timestamp) === today).length;
  const yCount = events.filter((e) => dayKey(e.timestamp) === yesterday).length;
  const delta = todayCount - yCount;
  $("#statEvents").textContent = todayCount;
  $("#statEventsDelta").textContent = delta === 0 ? "±0" : delta > 0 ? `+${delta}` : String(delta);
  $("#eventNavCount").textContent = todayCount;

  $("#overviewCameras").innerHTML = cameras.length
    ? cameras
        .slice(0, 6)
        .map((c, i) => {
          const scene = sceneOf(i);
          const art = scene === "preview-drive" ? "scene-road" : scene === "preview-back" ? "scene-garden" : "scene-door";
          return `<article class="camera-card"><div class="camera-preview ${scene}"><span class="preview-label"><i class="record-dot"></i> ${isOnline(c) ? "LIVE" : "OFFLINE"}</span><span class="camera-overlay">${camLabel(c)}</span><div class="${art}"></div></div><div class="camera-info"><div><strong>${escapeHtml(c.name)}</strong><small><span class="${isOnline(c) ? "online-dot" : "offline-dot"}"></span> ${isOnline(c) ? "Online" : "Not connected"} · ${escapeHtml(c.siteName)}</small></div></div></article>`;
        })
        .join("")
    : '<div class="empty-state"><strong>No cameras yet</strong><p>Add a location and a camera on the Connect CCTV page.</p></div>';
}

/* ---------- events ---------- */
function mapBackendEvent(event) {
  const label = event.person_label || "Unknown person";
  const type = event.event_type || "person_detected";
  const known = label !== "Unknown person" && !label.startsWith("DEMO CANDIDATE:");
  const cam = cameras.find((c) => c.id === event.camera_id);
  const isPerson = type === "person_detected";
  const confidence = typeof event.confidence === "number" ? ` · ${Math.round(event.confidence * 100)}% confidence` : "";
  return {
    id: event.id,
    timestamp: event.timestamp,
    time: formatEventTime(event.timestamp),
    title: isPerson ? (known ? `${label} detected` : "Person detected") : type.replaceAll("_", " "),
    detail: (event.details || (isPerson ? "Person detection event." : "Detection event.")) + confidence,
    camera: cam ? cam.name : `Camera ${event.camera_id ?? "Unknown"}`,
    type: known ? "known" : isPerson ? "unknown" : "other",
    icon: isPerson ? "♙" : "◉",
    color: known ? "green" : isPerson ? "purple" : "amber",
    recording: false,
  };
}

async function loadBackendEvents({ silent = false } = {}) {
  if (eventsLoading || !currentUser.id) return;
  eventsLoading = true;
  eventsError = "";
  const timeline = $("#eventTimeline");
  if (!silent && timeline) {
    timeline.innerHTML = `<div class="empty-state"><strong>Loading events…</strong><p>Fetching saved CCTV events.</p></div>`;
  }
  try {
    const lists = await Promise.all(sites.map((s) => apiRequest(`/locations/${s.id}/events`)));
    events = lists
      .flatMap((d) => (Array.isArray(d) ? d : d?.events || []))
      .map(mapBackendEvent)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    renderRecent();
    renderEvents();
    renderOverview();
  } catch (error) {
    eventsError = error.message;
    console.error("Could not load backend events:", error);
    if (timeline) {
      timeline.innerHTML = `<div class="empty-state"><strong>Couldn't load CCTV events</strong><p>${escapeHtml(eventsError)}</p><button class="primary-btn" id="retryEventsBtn" type="button">Try again</button></div>`;
      $("#retryEventsBtn")?.addEventListener("click", () => loadBackendEvents());
    }
  } finally {
    eventsLoading = false;
  }
}

function startTimelineAutoRefresh() {
  if (timelineRefreshTimer !== null) return;
  let ticks = 0;
  timelineRefreshTimer = setInterval(() => {
    if ($("#appShell").classList.contains("hidden") || document.hidden || !currentUser.id) return;
    ticks++;
    if ($("#page-events").classList.contains("active") || $("#page-overview").classList.contains("active")) {
      loadBackendEvents({ silent: true });
    }
    if (ticks % 6 === 0) checkHealth();
  }, 5000);
}

const EVENT_TAGS = { known: "Known person", unknown: "Unknown person", other: "Detection event" };

function eventMarkup(e, compact = false) {
  const title = escapeHtml(e.title),
    detail = escapeHtml(e.detail),
    camera = escapeHtml(e.camera);
  return `<div class="${compact ? "event-row" : "timeline-item"}">${
    compact
      ? `<div class="event-symbol ${e.color}">${e.icon}</div><div class="event-row-main"><strong>${title}</strong><p>${camera} · ${detail}</p></div><span class="event-time">${e.time}</span>`
      : `<div class="timeline-time">${e.time}</div><div class="timeline-rail"><span class="timeline-dot ${e.color}">${e.icon}</span></div><div class="timeline-content"><div><strong>${title}</strong><p>${detail}</p><div class="timeline-tags"><span class="timeline-tag">▣ ${camera}</span><span class="timeline-tag">${EVENT_TAGS[e.type] || "Event"}</span></div></div></div>`
  }</div>`;
}

function renderRecent() {
  $("#recentEvents").innerHTML = events.length
    ? events.slice(0, 4).map((e) => eventMarkup(e, true)).join("")
    : '<div class="empty-state"><strong>No events yet</strong><p>Detections from your cameras will show up here.</p></div>';
}

function renderEvents() {
  const q = ($("#eventSearch")?.value || "").toLowerCase();
  const type = $("#eventTypeFilter")?.value || "all";
  const date = $("#eventDateFilter").value;
  const day = date ? events.filter((e) => dayKey(e.timestamp) === date) : events;
  const filtered = day.filter(
    (e) => (type === "all" || e.type === type) && `${e.title} ${e.detail} ${e.camera}`.toLowerCase().includes(q),
  );
  $("#eventTimeline").innerHTML = filtered.map((e) => eventMarkup(e, false)).join("");
  $("#eventCount").textContent = `${filtered.length} event${filtered.length === 1 ? "" : "s"}`;
  $("#noEvents").classList.toggle("hidden", filtered.length > 0);
  $("#evStatTotal").textContent = day.length;
  $("#evStatKnown").textContent = day.filter((e) => e.type === "known").length;
  $("#evStatUnknown").textContent = day.filter((e) => e.type === "unknown").length;
  $("#evStatOther").textContent = day.filter((e) => e.type === "other").length;
  if (date) {
    const d = new Date(date + "T12:00:00");
    $("#timelineDateTitle").textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    $(".date-marker").textContent = d.getDate();
  }
}

/* ---------- session ---------- */
async function showApp(user) {
  currentUser = user;
  syncUser();
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  goPage("overview");
  await refreshWorkspace();
}

async function startSession({ access_token, user }) {
  authToken = access_token;
  writeJson("sentinel-session", { token: access_token });
  await showApp(user);
}

function endSession() {
  stopLiveCamera();
  resetLiveShots();
  authToken = null;
  localStorage.removeItem("sentinel-session");
  currentUser = { id: null, name: "", email: "" };
  cameras = [];
  sites = [];
  events = [];
  showAuth();
  authTab("signin");
  $("#signInPassword").value = "";
}

/* ---------- cameras and locations ---------- */
function renderCameraCard(c, i) {
  const scene = sceneOf(i);
  const art = scene === "preview-drive" ? "scene-road" : scene === "preview-back" ? "scene-garden" : "scene-door";
  return `<article class="camera-card"><div class="camera-preview ${scene}"><span class="preview-label"><i class="record-dot"></i> ${isOnline(c) ? "LIVE" : "OFFLINE"}</span><span class="camera-overlay">${camLabel(c)}</span><div class="${art}"></div></div><div class="camera-info"><div><strong>${escapeHtml(c.name)}</strong><small><span class="${isOnline(c) ? "online-dot" : "offline-dot"}"></span> ${isOnline(c) ? "Online" : escapeHtml(c.status || "Not connected")}</small><small class="camera-site-label">⌂ ${escapeHtml(c.siteName)} · ${escapeHtml(c.siteType)}</small></div><button class="dots-btn camera-more" data-camera-index="${i}">•••</button></div><div class="camera-info camera-extra"><span class="muted" style="font-size:10px">${escapeHtml(maskSource(c.source))}</span><button class="text-btn remove-camera-btn" data-remove-camera="${i}">Remove</button></div></article>`;
}

function renderCameras() {
  const grid = $("#allCamerasGrid");
  if (!grid) return;
  $("#cameraEmptyState").classList.toggle("hidden", cameras.length > 0);
  grid.classList.toggle("hidden", cameras.length === 0);
  $("#cameraNavCount").textContent = cameras.length;
  const first = (currentUser.name || "").split(" ")[0];
  $("#cameraWelcomeTitle").textContent = cameras.length ? `Welcome back, ${first}` : "Welcome to your security workspace";
  $("#cameraWelcomeText").textContent = cameras.length
    ? `${cameras.length} camera${cameras.length === 1 ? "" : "s"} across ${sites.length} location${sites.length === 1 ? "" : "s"}.`
    : "Start by adding a location and connecting your first CCTV. You can manage home, office, shop, and other sites from this page.";
  renderSites();
  grid.innerHTML = cameras.map(renderCameraCard).join("");
  $$(".remove-camera-btn", grid).forEach((b) =>
    b.addEventListener("click", async () => {
      const c = cameras[Number(b.dataset.removeCamera)];
      if (!c || !confirm(`Remove "${c.name}" and its saved events?`)) return;
      try {
        await apiRequest(`/cameras/${c.id}`, { method: "DELETE" });
        await refreshWorkspace();
        showToast(`${c.name} removed.`);
      } catch (error) {
        showToast(`Could not remove camera: ${error.message}`);
      }
    }),
  );
  $$(".camera-more", grid).forEach((b) =>
    b.addEventListener("click", () => {
      const c = cameras[Number(b.dataset.cameraIndex)];
      if (c)
        openModal(
          "Camera details",
          `<p><strong>${escapeHtml(c.name)}</strong></p><p>Location: ${escapeHtml(c.siteName)} · ${escapeHtml(c.siteType)}</p><p>Status: ${escapeHtml(c.status || "unknown")}</p><p>Source: ${escapeHtml(maskSource(c.source))}</p><button class="primary-btn close-modal-action" type="button">Close</button>`,
        );
    }),
  );
}

function renderSites() {
  const wrap = $("#cameraSites");
  if (!wrap) return;
  wrap.classList.toggle("hidden", !sites.length);
  wrap.innerHTML = sites
    .map((site) => {
      const cams = cameras.filter((c) => c.siteId === site.id);
      const icon = site.type === "Office" ? "▥" : site.type === "Shop" ? "▣" : site.type === "Warehouse" ? "▤" : "⌂";
      return `<article class="site-card"><div class="site-card-top"><div class="site-icon">${icon}</div><div class="site-title"><strong>${escapeHtml(site.name)}</strong><span>${escapeHtml(site.type)} · ${cams.length} camera${cams.length === 1 ? "" : "s"}</span></div><button class="site-add-camera text-btn" data-site-id="${site.id}">＋ Add camera</button></div><div class="site-camera-summary">${cams.length ? cams.map((c) => `<span class="site-camera-chip"><i class="${isOnline(c) ? "online-dot" : "offline-dot"}"></i>${escapeHtml(c.name)}</span>`).join("") : '<span class="muted">No cameras added at this location yet.</span>'}</div></article>`;
    })
    .join("");
  $$(".site-add-camera", wrap).forEach((b) =>
    b.addEventListener("click", () => openAddCameraModal(Number(b.dataset.siteId))),
  );
}

function openAddCameraModal(preselectedSiteId = null) {
  const siteOptions = sites
    .map((s) => `<option value="${s.id}" ${s.id === preselectedSiteId ? "selected" : ""}>${escapeHtml(s.name)} (${escapeHtml(s.type)})</option>`)
    .join("");
  openModal(
    "Add CCTV",
    `<form id="connectCameraForm" class="connect-camera-form"><label>Camera name<input id="newCameraName" required maxlength="60" placeholder="e.g. Reception camera"></label><label>Location<select id="newCameraSite" required>${siteOptions || '<option value="">Add a location first</option>'}</select></label><label>Stream source<input id="newCameraSource" placeholder="rtsp://… or path/to/video.mp4"></label><button class="primary-btn full-btn" type="submit">Save camera <span>→</span></button><p id="connectCameraMessage" class="auth-message" role="status"></p></form>`,
  );
  $("#connectCameraForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#newCameraName").value.trim(),
      siteId = Number($("#newCameraSite").value),
      source = $("#newCameraSource").value.trim();
    if (!name || !siteId) {
      $("#connectCameraMessage").textContent = "Add a location first, then enter a camera name.";
      return;
    }
    const btn = $("#connectCameraForm button[type='submit']");
    btn.disabled = true;
    try {
      await apiRequest(`/locations/${siteId}/cameras`, postJson({ name, source: source || null }));
      $("#modalBackdrop").classList.add("hidden");
      await refreshWorkspace();
      showToast(`${name} added.`);
    } catch (error) {
      btn.disabled = false;
      $("#connectCameraMessage").textContent = `Could not save camera: ${error.message}`;
    }
  });
}

function openAddSiteModal() {
  openModal(
    "Add a location",
    `<p>Create a separate space for each property or business site.</p><form id="addSiteForm" class="connect-camera-form"><label>Location name<input id="newSiteName" required maxlength="60" placeholder="e.g. City Office"></label><label>Location type<select id="newSiteType"><option>Home</option><option>Office</option><option>Shop</option><option>Warehouse</option><option>Other</option></select></label><label>Address (optional)<input id="newSiteAddress" maxlength="120"></label><button class="primary-btn full-btn" type="submit">Create location <span>→</span></button><p id="addSiteMessage" class="auth-message" role="status"></p></form>`,
  );
  $("#addSiteForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#newSiteName").value.trim(),
      type = $("#newSiteType").value,
      address = $("#newSiteAddress").value.trim();
    if (!name) return;
    if (sites.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      $("#addSiteMessage").textContent = "A location with this name already exists.";
      return;
    }
    const btn = $("#addSiteForm button[type='submit']");
    btn.disabled = true;
    try {
      await apiRequest("/locations", postJson({ name, address: address || null, type }));
      $("#modalBackdrop").classList.add("hidden");
      await refreshWorkspace();
      showToast(`${name} location added.`);
    } catch (error) {
      btn.disabled = false;
      $("#addSiteMessage").textContent = `Could not create location: ${error.message}`;
    }
  });
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
  $("#signInBtn").addEventListener("click", async () => {
    const email = $("#signInEmail").value.trim(),
      password = $("#signInPassword").value;
    if (!email || !password) {
      $("#authMessage").textContent = "Enter your email and password to continue.";
      return;
    }
    const btn = $("#signInBtn");
    btn.disabled = true;
    $("#authMessage").textContent = "";
    try {
      await startSession(await apiRequest("/auth/login", postJson({ email, password })));
    } catch (error) {
      $("#authMessage").textContent = error.message;
    } finally {
      btn.disabled = false;
    }
  });
  $("#signUpBtn").addEventListener("click", async () => {
    const name = $("#signUpName").value.trim(),
      email = $("#signUpEmail").value.trim(),
      password = $("#signUpPassword").value;
    if (!name || !email || !password) {
      $("#signUpMessage").textContent = "Please complete all fields.";
      return;
    }
    if (password.length < 8) {
      $("#signUpMessage").textContent = "Use at least 8 characters.";
      return;
    }
    const btn = $("#signUpBtn");
    btn.disabled = true;
    $("#signUpMessage").textContent = "";
    try {
      await apiRequest("/users", postJson({ name, email, password }));
      await startSession(await apiRequest("/auth/login", postJson({ email, password })));
      showToast("Welcome! Add a location, then connect your first CCTV.");
    } catch (error) {
      $("#signUpMessage").textContent = error.message;
    } finally {
      btn.disabled = false;
    }
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
    endSession();
    showToast("Signed out.");
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
    $("#playCamera").textContent = $("#archiveCamera").selectedOptions[0]?.textContent || "—";
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
  $("#profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#profileForm button[type='submit']");
    btn.disabled = true;
    try {
      currentUser = await apiRequest(
        `/users/${currentUser.id}`,
        { ...postJson({ name: $("#profileNameInput").value.trim(), email: $("#profileEmailInput").value.trim() }), method: "PATCH" },
      );
      syncUser();
      renderOverview();
      $("#settingsMessage").textContent = "Profile updated.";
      showToast("Profile details updated.");
    } catch (error) {
      $("#settingsMessage").textContent = error.message;
    } finally {
      btn.disabled = false;
    }
  });
  $("#knownPersonForm").addEventListener("submit", enrollKnownPerson);
  $$("[data-enroll-mode]").forEach((b) => b.addEventListener("click", () => setEnrollMode(b.dataset.enrollMode)));
  $("#liveStartBtn").addEventListener("click", startLiveCamera);
  $("#liveStopBtn").addEventListener("click", stopLiveCamera);
  $("#liveCaptureBtn").addEventListener("click", captureLive);
  $("#liveCameraSelect").addEventListener("change", () => {
    if (liveStream) startLiveCamera();
  });
  $$(".live-step").forEach((b) =>
    b.addEventListener("click", () => {
      livePose = POSES.findIndex((p) => p.key === b.dataset.pose);
      renderLive();
    }),
  );
  renderLive();
  $("#securityTab").addEventListener("click", () => {
    openModal(
      "Change password",
      `<form id="passwordForm" class="connect-camera-form"><label>Current password<input id="curPassword" type="password" autocomplete="current-password" required></label><label>New password (min 8 characters)<input id="newPassword" type="password" autocomplete="new-password" minlength="8" required></label><button class="primary-btn full-btn" type="submit">Update password <span>→</span></button><p id="passwordMessage" class="auth-message" role="status"></p></form>`,
    );
    $("#passwordForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await apiRequest(
          `/users/${currentUser.id}/password`,
          postJson({ current_password: $("#curPassword").value, new_password: $("#newPassword").value }),
        );
        $("#modalBackdrop").classList.add("hidden");
        showToast("Password updated.");
      } catch (error) {
        $("#passwordMessage").textContent = error.message;
      }
    });
  });
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
  const today = dayKey(new Date());
  $("#archiveDate").value = today;
  $("#eventDateFilter").value = today;
  startTimelineAutoRefresh();
  const saved = readJson("sentinel-session", null);
  if (saved?.token) {
    authToken = saved.token;
    apiRequest("/auth/me").then(showApp).catch(() => endSession());
  }



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
  try {
    const { url } = await apiRequest(`${recording.playback_url}/playback-token`, { method: "POST" });
    video.src = `${API_BASE}${url}`;
  } catch (error) {
    showToast(`Could not start playback: ${error.message}`);
    return;
  }

  video.addEventListener("error", () => {
    showToast("Playback failed. Check the video format and backend URL.");
  }, { once: true });
});
}
document.addEventListener("DOMContentLoaded", init);