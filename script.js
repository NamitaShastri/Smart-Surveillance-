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
  try {
    sessionStorage.setItem("sentinel-page", page);
  } catch {}
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











const hourText = (h) => new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
const recordedAt = (r) => r.recorded_at || r.modified_at;
const noVideoStage = (title, text) =>
  `<div class="video-placeholder"><span class="play-large">—</span><strong>${title}</strong><p>${text}</p></div>`;

function setPlaybackButtons(enabled) {
  $("#playLocalBtn").disabled = !enabled;
  $("#downloadInfoBtn").disabled = !enabled;
  $("#deleteRecordingBtn").disabled = !enabled;
}

const DELETE_REASONS = ["Recorded by mistake", "Test or demo footage", "Privacy request", "Free up storage", "Other"];

function openDeleteRecording() {
  const h = archiveHours[selectedHour];
  const recording = h?.recordings?.[0];
  if (!recording) {
    showToast("No video was recorded for this hour.");
    return;
  }
  const cam = $("#archiveCamera").selectedOptions[0]?.textContent || "";
  openModal(
    "Delete recording",
    `<p>This permanently deletes <strong>${escapeHtml(recording.filename)}</strong> (${escapeHtml(h.label)}, ${escapeHtml($("#archiveDate").value)}, ${escapeHtml(cam)}). It cannot be undone. The reason is kept in an audit log.</p>
     <form id="deleteRecordingForm" class="delete-form" data-camera="${recording.camera_id}" data-file="${escapeHtml(recording.filename)}">
       <label>Reason<select id="deleteReasonSelect">${DELETE_REASONS.map((r) => `<option>${r}</option>`).join("")}</select></label>
       <label>Details <span class="muted">(required for “Other”)</span><textarea id="deleteReasonText" rows="3" maxlength="250" placeholder="Add a short explanation"></textarea></label>
       <p id="deleteRecordingMsg" class="auth-message" role="alert"></p>
       <div class="delete-actions">
         <button class="primary-btn danger-btn" type="submit">Delete permanently</button>
         <button class="secondary-btn close-modal-action" type="button">Cancel</button>
       </div>
     </form>`,
  );
}

async function submitDeleteRecording(form) {
  const message = $("#deleteRecordingMsg");
  const choice = $("#deleteReasonSelect").value;
  const details = $("#deleteReasonText").value.trim();
  if (choice === "Other" && details.length < 3) {
    message.textContent = "Please describe the reason (at least 3 characters).";
    return;
  }
  const reason = details ? `${choice}: ${details}` : choice;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  message.textContent = "Deleting…";
  try {
    await apiRequest(`/recordings/${form.dataset.camera}/${encodeURIComponent(form.dataset.file)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    $("#modalBackdrop").classList.add("hidden");
    showToast("Recording deleted.");
    loadRecordingCount();
    await renderHours();
  } catch (error) {
    button.disabled = false;
    message.textContent = `Could not delete: ${error.message}`;
  }
}

// Shows all 24 hours of the selected day. Like a real CCTV recorder, each hour
// holds at most one recording (the newest file if more than one was saved).
async function renderHours() {
  const date = $("#archiveDate").value;
  const list = $("#hourlyList");
  const cameraId = Number($("#archiveCamera").value);
  archiveHours = [];
  setPlaybackButtons(false);

  if (!date) {
    list.innerHTML = '<p class="hour-message">Choose a date to view its recordings.</p>';
    return;
  }
  $("#archiveDateTitle").textContent = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  if (!cameraId) {
    list.innerHTML = '<p class="hour-message">Add a camera first to browse its recordings.</p>';
    $("#archiveSummaryText").textContent = "No cameras";
    $("#videoStage").innerHTML = noVideoStage("No camera", "Add a camera on the Connect CCTV page.");
    return;
  }
  list.innerHTML = '<p class="hour-message">Loading saved recordings...</p>';

  try {
    archiveRecordings = await apiRequest(`/recordings?camera_id=${cameraId}`);
    const daily = archiveRecordings
      .filter((r) => dayKey(recordedAt(r)) === date)
      .sort((a, b) => new Date(recordedAt(b)) - new Date(recordedAt(a)));

    archiveHours = Array.from({ length: 24 }, (_, hour) => {
      const inHour = daily.filter((r) => new Date(recordedAt(r)).getHours() === hour);
      return { hour, label: hourText(hour), recordings: inHour.slice(0, 1), older: Math.max(0, inHour.length - 1) };
    });
    const recorded = archiveHours.filter((h) => h.recordings.length);
    $("#archiveSummaryText").textContent = recorded.length
      ? `${recorded.length} of 24 hours recorded`
      : "No video recorded on this date";

    list.innerHTML = archiveHours
      .map((h) => {
        const has = h.recordings.length > 0;
        return `<button type="button" class="hour-row ${has ? "has-video" : "no-video"}" data-hour="${h.hour}" title="${has ? "Recording available" : "No video recorded"}"><span class="hour-label">${h.label}</span><span class="hour-bar ${has ? "" : "empty"}"><span style="width:100%"></span></span><span class="clip-count">${has ? "●" : "—"}</span></button>`;
      })
      .join("");

    // Keep the chosen hour if there is one, otherwise open the latest recorded hour.
    if (selectedHour === null || !archiveHours[selectedHour]) {
      selectedHour = recorded.length ? recorded[recorded.length - 1].hour : null;
    }
    if (selectedHour === null) {
      $("#playHour").textContent = "—";
      $("#playbackSubhead").textContent = "Select an hour to preview its recording.";
      $("#videoStage").innerHTML = noVideoStage("No video recorded", "Nothing was recorded on this date. You can still pick any hour.");
      return;
    }
    selectHour(selectedHour);
  } catch (error) {
    console.error("Failed to load archive recordings:", error);
    $("#archiveSummaryText").textContent = "Unable to load recordings";
    list.innerHTML = '<p class="hour-message">Couldn\'t load saved recordings. Check that the backend is running.</p>';
  }
}

function selectHour(hour) {
  selectedHour = hour;
  const h = archiveHours[hour];
  if (!h) return;

  const cam = $("#archiveCamera").selectedOptions[0]?.textContent || "";
  $("#playCamera").textContent = cam;
  $("#playHour").textContent = h.label;
  $("#playbackSubhead").textContent = `${h.label} · ${cam}`;

  const row = [...document.querySelectorAll(".hour-row")].find((b) => Number(b.dataset.hour) === hour);
  document.querySelectorAll(".hour-row").forEach((b) => b.classList.toggle("selected", b === row));
  row?.scrollIntoView?.({ block: "nearest" });

  const recording = h.recordings[0];
  setPlaybackButtons(Boolean(recording));
  $("#videoStage").innerHTML = recording
    ? `<div class="video-placeholder"><span class="play-large">▶</span><strong>${escapeHtml(recording.filename)}</strong><p>Press Play preview to watch this recording.</p></div>`
    : noVideoStage("No video recorded", `There is no footage for ${h.label} on this date.`);
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
  if (demo.stream) {
    message.textContent = "The camera simulator is using the webcam. Press Stop & save in the ♧ panel first.";
    return;
  }
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
const rawOnline = (c) =>
  ["online", "active", "connected", "running"].includes(String(c.status || "").toLowerCase());
// The simulator's camera is online exactly while the simulator is running (never a stale database value).
const isDemoCamera = (c) => c.name === DEMO_CAMERA && c.source === "browser-webcam";
const isOnline = (c) => (isDemoCamera(c) ? Boolean(demo.stream) : rawOnline(c));
// While the simulator is live, its card shows the live picture instead of the placeholder scene.
const cameraArt = (c, art) =>
  isDemoCamera(c) && demo.stream
    ? '<canvas class="camera-live-canvas" data-live-cam width="640" height="480"></canvas>'
    : `<div class="${art}"></div>`;
function syncCameraViews() {
  try {
    renderCameras();
    renderOverview();
  } catch (error) {
    console.error("Could not refresh camera cards:", error);
  }
}
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
          return `<article class="camera-card"><div class="camera-preview ${scene}"><span class="preview-label"><i class="record-dot"></i> ${isOnline(c) ? "LIVE" : "OFFLINE"}</span><span class="camera-overlay">${camLabel(c)}</span>${cameraArt(c, art)}</div><div class="camera-info"><div><strong>${escapeHtml(c.name)}</strong><small><span class="${isOnline(c) ? "online-dot" : "offline-dot"}"></span> ${isOnline(c) ? "Online" : "Not connected"} · ${escapeHtml(c.siteName)}</small></div></div></article>`;
        })
        .join("")
    : '<div class="empty-state"><strong>No cameras yet</strong><p>Add a location and a camera on the Connect CCTV page.</p></div>';
}

/* ---------- events ---------- */
function mapBackendEvent(event) {
  const label = event.person_label || "Unknown person";
  const type = event.event_type || "person_detected";
  const left = type === "person_left";
  const isPerson = type === "person_detected" || left;
  const known = isPerson && !/^Unknown person( \d+)?$/.test(label) && !label.startsWith("DEMO CANDIDATE:");
  const cam = cameras.find((c) => c.id === event.camera_id);
  const confidence = typeof event.confidence === "number" ? ` · ${Math.round(event.confidence * 100)}% confidence` : "";
  return {
    id: event.id,
    timestamp: event.timestamp,
    time: formatEventTime(event.timestamp),
    title: left
      ? `${known ? label : label || "Unknown person"} left ${cam ? cam.name : "the camera"}`
      : isPerson ? (known || label !== "Unknown person" ? `${label} detected` : "Person detected") : type.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()),
    detail: (event.details || (isPerson ? "Person detection event." : "Detection event.")) + confidence,
    camera: cam ? cam.name : `Camera ${event.camera_id ?? "Unknown"}`,
    type: known ? "known" : isPerson ? "unknown" : "other",
    left,
    icon: left ? "↪" : isPerson ? "♙" : "◉",
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
  $("#evStatKnown").textContent = day.filter((e) => e.type === "known" && !e.left).length;
  $("#evStatUnknown").textContent = day.filter((e) => e.type === "unknown" && !e.left).length;
  $("#evStatOther").textContent = day.filter((e) => e.type === "other").length;
  if (date) {
    const d = new Date(date + "T12:00:00");
    $("#timelineDateTitle").textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    $(".date-marker").textContent = d.getDate();
  }
}

/* ---------- session ---------- */
async function showApp(user, startPage = "overview") {
  currentUser = user;
  syncUser();
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  goPage(startPage);
  await refreshWorkspace();
}

async function startSession({ access_token, user }) {
  authToken = access_token;
  writeJson("sentinel-session", { token: access_token });
  await showApp(user);
}

function endSession() {
  sessionStorage.removeItem("sentinel-page");
  stopDemoCamera({ save: false });
  $("#demoDock")?.classList.add("hidden");
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
  return `<article class="camera-card"><div class="camera-preview ${scene}"><span class="preview-label"><i class="record-dot"></i> ${isOnline(c) ? "LIVE" : "OFFLINE"}</span><span class="camera-overlay">${camLabel(c)}</span>${cameraArt(c, art)}</div><div class="camera-info"><div><strong>${escapeHtml(c.name)}</strong><small><span class="${isOnline(c) ? "online-dot" : "offline-dot"}"></span> ${isOnline(c) ? "Online" : isDemoCamera(c) ? "Offline" : escapeHtml(c.status || "Not connected")}</small><small class="camera-site-label">⌂ ${escapeHtml(c.siteName)} · ${escapeHtml(c.siteType)}</small></div><button class="dots-btn camera-more" data-camera-index="${i}">•••</button></div><div class="camera-info camera-extra"><span class="muted" style="font-size:10px">${escapeHtml(maskSource(c.source))}</span><button class="text-btn remove-camera-btn" data-remove-camera="${i}">Remove</button></div></article>`;
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
          `<p><strong>${escapeHtml(c.name)}</strong></p><p>Location: ${escapeHtml(c.siteName)} · ${escapeHtml(c.siteType)}</p><p>Status: ${escapeHtml(isOnline(c) ? "online" : isDemoCamera(c) ? "offline" : c.status || "unknown")}</p><p>Source: ${escapeHtml(maskSource(c.source))}</p><button class="primary-btn close-modal-action" type="button">Close</button>`,
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

/* ---------- camera simulator: the webcam acts as a CCTV camera ---------- */
const DEMO_SITE = "Demo lab";
const DEMO_CAMERA = "Live webcam (demo)";
const SCAN_MIN_GAP_MS = 400; // pause between checks; a new frame is sent as soon as the last answer arrives
const LEAVE_AFTER_MS = 10000; // out of view this long = the person left
const STRANGER_CONFIRM_CHECKS = 1; // checks a new stranger must be seen in before they count (1 = immediately; raise to ignore one-frame glitches)
const STRANGER_SAME_SIM = 0.45; // face similarity at/above which two sightings are the same stranger
const STRANGER_TRACK_SIM = 0.2; // lower bar when the face is in the same spot as a moment ago
const STRANGER_MAX = 50;
const MAX_SESSION_MS = 12 * 60 * 60 * 1000; // safety cap; long sessions are auto-saved in pieces
const SEGMENT_MS = 10 * 60 * 1000; // auto-save at least this often (and at every clock hour)
const demo = { stream: null, video: null, drawTimer: null, scanTimer: null, limitTimer: null, recorder: null, recStream: null, segTimer: null, pending: [], uploadChain: Promise.resolve(), savedHours: new Set(), lastError: "", busy: false, camera: null, session: "", present: new Map(), pendingLeaves: [], strangers: [], strangerNo: 0, counter: 0, overlay: "", unknownStreak: 0, faces: [], facesAt: 0, faceW: 0, faceH: 0 };

const pad2 = (n) => String(n).padStart(2, "0");
const clockText = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

async function reloadCameras() {
  await loadWorkspace();
  renderCameras();
  fillArchiveCameras();
  renderOverview();
}

// The simulator needs a camera record in the database; create it the first time.
async function ensureDemoCamera() {
  let site = sites.find((s) => s.name === DEMO_SITE);
  if (!site) {
    await apiRequest("/locations", postJson({ name: DEMO_SITE, address: "Browser webcam", type: "Other" }));
    await loadWorkspace();
    site = sites.find((s) => s.name === DEMO_SITE);
  }
  let camera = cameras.find((c) => c.siteId === site.id && c.name === DEMO_CAMERA);
  if (!camera) {
    await apiRequest(`/locations/${site.id}/cameras`, postJson({ name: DEMO_CAMERA, source: "browser-webcam" }));
    await loadWorkspace();
    camera = cameras.find((c) => c.siteId === site.id && c.name === DEMO_CAMERA);
  }
  renderCameras();
  fillArchiveCameras();
  renderOverview();
  return camera;
}

const setCameraStatus = (id, status) =>
  apiRequest(`/cameras/${id}/status`, { ...postJson({ status }), method: "PATCH" });

function drawDemoFrame() {
  const video = demo.video;
  if (!video?.videoWidth) return;
  const canvas = $("#demoCanvas");
  const w = Math.min(640, video.videoWidth);
  const h = Math.round((w * video.videoHeight) / video.videoWidth);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext("2d");
  g.drawImage(video, 0, 0, w, h);
  // One box per face found in the latest check: green = known person, red = unknown.
  if (demo.faces.length && demo.faceW && Date.now() - demo.facesAt < 2500) {
    const sx = w / demo.faceW;
    const sy = h / demo.faceH;
    g.font = "bold 12px monospace";
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    for (const face of demo.faces) {
      const [x1, y1, x2, y2] = [face.box[0] * sx, face.box[1] * sy, face.box[2] * sx, face.box[3] * sy];
      const color = face.known ? "#3ddc84" : "#ff5d5d";
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const textWidth = g.measureText(face.label).width + 8;
      const above = y1 > 44;
      const labelY = above ? y1 - 18 : y2 + 2;
      g.fillStyle = color;
      g.fillRect(x1, labelY, textWidth, 16);
      g.fillStyle = "#000";
      g.fillText(face.label, x1 + 4, labelY + 12);
    }
  }
  // CCTV-style burn-in, so the saved footage carries the camera name, time and detection.
  g.fillStyle = "rgba(0,0,0,.55)";
  g.fillRect(0, 0, w, 22);
  g.fillRect(0, h - 26, w, 26);
  g.fillStyle = "#fff";
  g.font = "12px monospace";
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillText(`CAM ${pad2(demo.camera.id)} · ${DEMO_CAMERA}`, 8, 11);
  g.fillText(demo.overlay, 8, h - 13);
  g.textAlign = "right";
  g.fillText(clockText(), w - 8, 11);
  if (Math.floor(Date.now() / 500) % 2) {
    g.fillStyle = "#ff4d4d";
    g.beginPath();
    g.arc(w - 12, h - 13, 5, 0, Math.PI * 2);
    g.fill();
  }
  // Mirror the same picture into the camera cards (Overview and Connect CCTV).
  document.querySelectorAll("canvas[data-live-cam]").forEach((target) => {
    if (target.offsetParent === null) return; // on a page that isn't showing
    if (target.width !== w || target.height !== h) {
      target.width = w;
      target.height = h;
    }
    target.getContext("2d").drawImage(canvas, 0, 0);
  });
}

function startDemoRecorder() {
  demo.recorder = null;
  if (typeof MediaRecorder === "undefined") return;
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
  demo.recStream ||= $("#demoCanvas").captureStream(15);
  const recorder = new MediaRecorder(demo.recStream, mime ? { mimeType: mime, videoBitsPerSecond: 1500000 } : {});
  recorder.chunks = []; // each segment keeps its own chunks
  recorder.startedAt = Date.now();
  recorder.ondataavailable = (e) => {
    if (e.data?.size) recorder.chunks.push(e.data);
  };
  recorder.start(2000);
  demo.recorder = recorder;
  scheduleSegmentEnd();
}

// Stop a recorder and resolve with everything it captured (or null).
function finishRecorder(recorder) {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === "inactive") return resolve(null);
    recorder.onstop = () => resolve(new Blob(recorder.chunks, { type: recorder.mimeType || "video/webm" }));
    recorder.stop();
  });
}

// Next auto-save: the top of the clock hour or SEGMENT_MS from now, whichever comes first.
function scheduleSegmentEnd() {
  clearTimeout(demo.segTimer);
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  demo.segTimer = setTimeout(rollOverRecording, Math.min(SEGMENT_MS, nextHour - now));
}

// Uploads run one at a time, in order, because the server appends each piece to its hour file.
function flushUploads() {
  demo.uploadChain = demo.uploadChain.then(async () => {
    while (demo.pending.length) {
      const item = demo.pending[0];
      try {
        const form = new FormData();
        form.append("video", item.blob, "webcam.webm");
        form.append("ended_at", item.endedAt);
        const saved = await apiRequest(`/cameras/${item.cameraId}/recordings`, { method: "POST", body: form });
        demo.pending.shift();
        saved.recordings.forEach((r) => demo.savedHours.add(parseInt(r.hour, 10)));
        demo.lastError = "";
      } catch (error) {
        demo.lastError = error.message;
        if (error.status >= 400 && error.status < 500) {
          demo.pending.shift(); // the server rejected this piece; retrying won't help
          continue;
        }
        break; // network / server trouble: keep it and retry on the next save
      }
    }
  });
  return demo.uploadChain;
}

function queueUpload(blob, endedAtMs, startedAtMs) {
  if (!blob || blob.size === 0 || endedAtMs - startedAtMs < 1500) return flushUploads(); // too short to keep
  demo.pending.push({ blob, endedAt: new Date(endedAtMs).toISOString(), cameraId: demo.camera.id });
  return flushUploads();
}

// Save the footage so far and keep recording without a gap.
async function rollOverRecording() {
  const old = demo.recorder;
  if (!demo.stream || !old) return;
  const switchedAt = Date.now();
  startDemoRecorder(); // the new piece starts first, so no frames are missed
  const blob = await finishRecorder(old);
  await queueUpload(blob, switchedAt, old.startedAt);
  const note = $("#demoSaveNote");
  if (demo.stream && note) {
    note.textContent = demo.pending.length
      ? `Auto-save failed (${demo.lastError}). Will retry at the next save.`
      : `Auto-saved to the archive at ${new Date().toLocaleTimeString()}.`;
  }
  loadRecordingCount();
  if ($("#page-recordings").classList.contains("active")) renderHours();
}

function addDemoLog(label, verb = "entered") {
  const row = document.createElement("div");
  row.className = "demo-log-row";
  row.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${verb} · ${new Date().toLocaleTimeString()}</span>`;
  $("#demoLog").prepend(row);
  while ($("#demoLog").children.length > 5) $("#demoLog").lastChild.remove();
}

/* Presence: one "detected" event when a person comes into view and one "left" event when they
   are out of view for LEAVE_AFTER_MS. Staying in view (even for hours) is a single visit; leaving
   and coming back is a new visit with its own pair of events. */
const fmtDuration = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${total % 60}s` : `${total}s`;
};

async function postPresenceEvent(visit, kind, atMs, note = "") {
  const left = kind === "leave";
  const similarity = visit.similarity;
  await apiRequest(
    `/cameras/${demo.camera.id}/events`,
    postJson({
      event_type: left ? "person_left" : "person_detected",
      person_label: visit.label,
      confidence: left || similarity == null ? null : Math.min(1, Math.max(0, similarity)),
      tracking_id: `${demo.session}-${visit.id}`,
      details: left
        ? `Left ${DEMO_CAMERA} · in view for ${fmtDuration(atMs - visit.enteredAt)}${note}`
        : `Entered ${DEMO_CAMERA}${similarity == null ? "" : ` · face similarity ${similarity.toFixed(2)}`}`,
      timestamp: new Date(atMs).toISOString(), // a departure is stamped with when they were last seen
      event_key: `live:${demo.camera.id}:${demo.session}:${visit.id}:${kind}`, // the backend also refuses duplicates
    }),
  );
}

async function sendLeave(visit, atMs, note = "") {
  try {
    await postPresenceEvent(visit, "leave", atMs, note);
    addDemoLog(visit.label, "left");
    return true;
  } catch (error) {
    demo.pendingLeaves.push({ visit, atMs, note }); // retried on the next check
    $("#demoStatus").textContent = `Could not save the event: ${error.message}`;
    return false;
  }
}

// `seen`: label -> similarity for everyone confirmed in view during this check.
async function updatePresence(seen) {
  const now = Date.now();
  let changed = false;

  for (const [label, similarity] of seen) {
    let visit = demo.present.get(label);
    if (!visit) {
      demo.counter += 1;
      visit = { id: demo.counter, label, enteredAt: now, lastSeen: now, similarity, entered: false };
      demo.present.set(label, visit);
    }
    visit.lastSeen = now;
    if (similarity != null) visit.similarity = similarity;
  }

  for (const visit of demo.present.values()) {
    if (visit.entered) continue;
    try {
      await postPresenceEvent(visit, "enter", visit.enteredAt);
      visit.entered = true;
      addDemoLog(visit.label, "entered");
      changed = true;
    } catch (error) {
      $("#demoStatus").textContent = `Could not save the event: ${error.message}`; // retried next check
    }
  }

  for (const [label, visit] of [...demo.present]) {
    if (seen.has(label) || now - visit.lastSeen < LEAVE_AFTER_MS) continue;
    demo.present.delete(label);
    if (visit.entered && (await sendLeave(visit, visit.lastSeen))) changed = true;
  }

  for (const queued of demo.pendingLeaves.splice(0)) {
    if (await sendLeave(queued.visit, queued.atMs, queued.note)) changed = true;
  }

  if (changed) await loadBackendEvents({ silent: true });
}

// When the camera stops, close every open visit (stamped with the last time the person was seen).
async function closeOpenVisits() {
  const open = [...demo.present.values()];
  demo.present.clear();
  for (const visit of open) if (visit.entered) await sendLeave(visit, visit.lastSeen, " · camera stopped");
  for (const queued of demo.pendingLeaves.splice(0)) await sendLeave(queued.visit, queued.atMs, queued.note);
}

/* Stranger tracking: every unrecognised person gets their own number ("Unknown person 1", 2, ...).
   A face is the same stranger as before if its embedding is close to one seen earlier, or if it is
   in the same spot as that stranger a moment ago. Nothing is stored beyond this camera session. */
const faceDot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};
function boxIou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

// Returns, for each unknown face, the stranger record it belongs to (existing or new).
function assignStrangers(faces) {
  const now = Date.now();
  const pairs = [];
  faces.forEach((face, fi) => {
    if (!Array.isArray(face.embedding)) return;
    demo.strangers.forEach((s, si) => {
      const sim = Math.max(...s.vectors.map((v) => faceDot(face.embedding, v)));
      const sameSpot = now - s.seenAt < 3000 && boxIou(face.bbox, s.box) > 0.3;
      if (sim >= STRANGER_SAME_SIM || (sameSpot && sim >= STRANGER_TRACK_SIM)) pairs.push({ fi, si, sim });
    });
  });
  pairs.sort((a, b) => b.sim - a.sim); // best matches first; one stranger per face and vice versa
  const byFace = new Map();
  const taken = new Set();
  for (const p of pairs) {
    if (byFace.has(p.fi) || taken.has(p.si)) continue;
    byFace.set(p.fi, demo.strangers[p.si]);
    taken.add(p.si);
  }
  return faces.map((face, fi) => {
    let stranger = byFace.get(fi);
    if (!stranger) {
      demo.strangerNo += 1;
      stranger = { no: demo.strangerNo, vectors: [], box: face.bbox, seenAt: now, hits: 0 };
      demo.strangers.push(stranger);
      if (demo.strangers.length > STRANGER_MAX) {
        demo.strangers.sort((a, b) => b.seenAt - a.seenAt);
        demo.strangers.length = STRANGER_MAX;
      }
    }
    stranger.box = face.bbox;
    stranger.seenAt = now;
    stranger.hits += 1;
    if (Array.isArray(face.embedding)) {
      // keep a few different views of the face (front, turned...) so a returning stranger still matches
      const nearDuplicate = stranger.vectors.some((v) => faceDot(face.embedding, v) > 0.85);
      if (!nearDuplicate) {
        stranger.vectors.push(face.embedding);
        if (stranger.vectors.length > 8) stranger.vectors.shift();
      }
    }
    return stranger;
  });
}

async function scanDemoFrame() {
  const video = demo.video;
  if (demo.busy || !video?.videoWidth) return;
  demo.busy = true;
  const began = performance.now();
  try {
    const w = Math.min(640, video.videoWidth);
    const h = Math.round((w * video.videoHeight) / video.videoWidth);
    const frame = document.createElement("canvas"); // the raw frame, without the burn-in text
    frame.width = w;
    frame.height = h;
    frame.getContext("2d").drawImage(video, 0, 0, w, h);
    const blob = await new Promise((resolve) => frame.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || !demo.stream) return;
    const form = new FormData();
    form.append("image", new File([blob], "frame.jpg", { type: "image/jpeg" }));

    let result;
    try {
      result = await apiRequest(`/face-profiles/${currentUser.id}/verify-frame`, { method: "POST", body: form });
    } catch (error) {
      if (error.status === 401) return;
      demo.unknownStreak = 0;
      demo.faces = [];
      demo.overlay = "Camera check failed";
      $("#demoStatus").textContent = error.message;
      return;
    }
    if (!demo.stream) return; // stopped while waiting for the answer

    const seconds = ((performance.now() - began) / 1000).toFixed(1);
    const faces = Array.isArray(result?.faces) ? result.faces : [];
    const pct = (f) => (Number.isFinite(f.best_similarity) ? ` ${Math.round(f.best_similarity * 100)}%` : "");
    const known = faces.filter((f) => f.identity_verified === true && f.matched_profile?.display_name);
    const unknown = faces.filter((f) => !known.includes(f));
    const strangerOf = new Map();
    assignStrangers(unknown).forEach((stranger, i) => strangerOf.set(unknown[i], stranger));

    // Boxes for the picture (kept for a moment, then they fade if no new check arrives).
    demo.faceW = result?.image_width || 0;
    demo.faceH = result?.image_height || 0;
    demo.facesAt = Date.now();
    demo.faces = faces.map((f) => {
      const isKnown = known.includes(f);
      return { box: f.bbox, known: isKnown, label: isKnown ? `${f.matched_profile.display_name}${pct(f)}` : `Unknown ${strangerOf.get(f).no}` };
    });

    if (!faces.length) {
      demo.overlay = "No face in view";
      $("#demoStatus").textContent = `No face in view (${seconds}s)`;
      await updatePresence(new Map()); // nobody seen: lets departures be noticed
      return;
    }

    const parts = [...known.map((f) => `${f.matched_profile.display_name}${pct(f)}`)];
    for (const f of unknown) parts.push(`Unknown ${strangerOf.get(f).no}`);
    let note = `${faces.length} face${faces.length === 1 ? "" : "s"}: ${parts.join(", ")}.`;
    const why = unknown[0]?.verification_reason;
    if (why === "no_eligible_candidate") note += " Nobody is enrolled yet. Add faces on the Known people page.";
    else if (why === "ambiguous_candidates") note += " A face matches two profiles almost equally. Delete duplicate profiles in Known people.";
    $("#demoStatus").textContent = `${note} (${seconds}s)`;
    demo.overlay = parts.join(" · ");

    // Who is in view right now? Recognised people, and every stranger (each with their own number).
    const seen = new Map();
    for (const f of known) seen.set(f.matched_profile.display_name, f.best_similarity);
    for (const f of unknown) {
      const stranger = strangerOf.get(f);
      const label = `Unknown person ${stranger.no}`;
      if (stranger.hits >= STRANGER_CONFIRM_CHECKS || demo.present.has(label)) {
        seen.set(label, Number.isFinite(f.best_similarity) ? f.best_similarity : null);
      }
    }
    await updatePresence(seen);
  } finally {
    demo.busy = false;
  }
}

// Sends the next frame as soon as the previous answer is back (no fixed wait).
async function demoScanLoop(session) {
  while (demo.stream && demo.session === session) {
    const began = Date.now();
    await scanDemoFrame();
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, SCAN_MIN_GAP_MS - (Date.now() - began))));
  }
}

async function startDemoCamera() {
  const status = $("#demoStatus");
  if (demo.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = "This browser can't use the webcam here. Open the dashboard from localhost or HTTPS.";
    return;
  }
  $("#demoStartBtn").disabled = true;
  stopLiveCamera(); // free the Known people webcam if it was on
  try {
    status.textContent = "Starting camera…";
    demo.camera = await ensureDemoCamera();
    demo.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = demo.stream;
    await video.play();
    demo.video = video;
    demo.session = Date.now().toString(36);
    demo.present = new Map();
    demo.pendingLeaves = [];
    demo.strangers = [];
    demo.strangerNo = 0;
    demo.savedHours = new Set();
    demo.lastError = "";
    $("#demoSaveNote").textContent = "";
    demo.counter = 0;
    demo.unknownStreak = 0;
    demo.faces = [];
    demo.overlay = "Checking face…";
    drawDemoFrame();
    startDemoRecorder();
    flushUploads(); // retry anything an earlier session could not upload
    demo.drawTimer = setInterval(drawDemoFrame, 66);
    demoScanLoop(demo.session); // first check starts immediately
    demo.limitTimer = setTimeout(() => stopDemoCamera(), MAX_SESSION_MS);
    $("#demoOff").classList.add("hidden");
    $("#demoRec").classList.remove("hidden");
    $("#demoWarn")?.classList.remove("hidden");
    $("#demoStopBtn").disabled = false;
    $("#notificationBtn").classList.add("is-live");
    syncCameraViews(); // cards switch to LIVE immediately
    status.textContent = "Camera is live and recording. Step into view to be detected.";
    await setCameraStatus(demo.camera.id, "online");
    await reloadCameras();
  } catch (error) {
    demo.stream?.getTracks().forEach((t) => t.stop());
    demo.stream = null;
    clearInterval(demo.drawTimer);
    clearInterval(demo.scanTimer);
    clearTimeout(demo.limitTimer);
    clearTimeout(demo.segTimer);
    demo.recStream = null;
    $("#demoStartBtn").disabled = false;
    status.textContent = `Could not start the camera: ${error.message}`;
  }
}

async function stopDemoCamera({ save = true } = {}) {
  if (!demo.stream) return;
  clearInterval(demo.drawTimer);
  clearInterval(demo.scanTimer);
  clearTimeout(demo.limitTimer);
  clearTimeout(demo.segTimer);
  const recorder = demo.recorder;
  const endedAt = Date.now();
  const blob = await finishRecorder(recorder);
  demo.stream.getTracks().forEach((t) => t.stop());
  demo.recStream?.getTracks().forEach((t) => t.stop());
  demo.recStream = null;
  demo.stream = null;
  demo.video = null;
  demo.recorder = null;
  demo.faces = [];
  demo.strangers = []; // stranger face data is kept in memory only while the camera runs
  $("#demoOff").classList.remove("hidden");
  $("#demoRec").classList.add("hidden");
  $("#demoWarn")?.classList.add("hidden");
  $("#demoSaveNote").textContent = "";
  $("#demoStartBtn").disabled = false;
  $("#demoStopBtn").disabled = true;
  $("#notificationBtn").classList.remove("is-live");
  syncCameraViews(); // cards switch to OFFLINE immediately, before any upload finishes
  if (authToken && demo.camera) await closeOpenVisits();
  if (!save) {
    // Discarded: this last piece is dropped (earlier auto-saved pieces stay in the archive).
    if (authToken && demo.camera) {
      try {
        await setCameraStatus(demo.camera.id, "offline");
        await reloadCameras();
      } catch {}
    }
    return;
  }

  const camera = demo.camera;
  const status = $("#demoStatus");
  status.textContent = "Saving the recording…";
  await queueUpload(blob, endedAt, recorder?.startedAt ?? endedAt);
  if (demo.pending.length) {
    status.textContent = `Part of the recording was not saved: ${demo.lastError}. It will be retried next time you start or stop the camera.`;
  } else if (demo.savedHours.size) {
    const hours = [...demo.savedHours].sort((x, y) => x - y).map(hourText).join(", ");
    status.textContent = `Saved to the Recording archive (${hours}).`;
    showToast(`Recording saved to the archive (${hours}).`);
  } else {
    status.textContent = "Camera stopped (nothing was recorded).";
  }
  try {
    await setCameraStatus(camera.id, "offline");
    await reloadCameras();
  } catch {}
  loadRecordingCount();
  loadBackendEvents({ silent: true });
  if ($("#page-recordings").classList.contains("active")) renderHours();
}

/* ---- simulator panel: open/close, tabs, manual events ---- */
async function openDemoDock() {
  $("#demoDock").classList.remove("hidden");
  const mine = cameras.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} · ${escapeHtml(c.siteName)}</option>`).join("");
  const hasDemo = cameras.some((c) => c.name === DEMO_CAMERA);
  $("#demoEventCamera").innerHTML = (hasDemo ? "" : `<option value="demo">${DEMO_CAMERA} (created for you)</option>`) + mine;
  const now = new Date();
  $("#demoEventTime").value = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  try {
    if (!knownPeople.length) {
      const data = await apiRequest(`/face-profiles/${currentUser.id}`);
      knownPeople = Array.isArray(data) ? data : Array.isArray(data?.profiles) ? data.profiles : [];
    }
  } catch {}
  $("#demoPeople").innerHTML = knownPeople.map((p) => `<option value="${escapeHtml(p.display_name || "")}"></option>`).join("");
}

// Leaving the simulator while recording stops the camera WITHOUT saving; make that explicit.
function confirmLeaveRecording() {
  if (!demo.stream) return true;
  const leave = window.confirm(
    "Recording is still running.\n\n" +
      "If you leave now, the recording will be STOPPED and the footage since the last auto-save (at most 10 minutes) will NOT be saved to the archive.\n" +
      "To keep it, press Cancel and click “Stop & save”.\n\n" +
      "Leave and discard it?",
  );
  if (!leave) return false;
  stopDemoCamera({ save: false });
  return true;
}

function closeDemoDock() {
  if (!confirmLeaveRecording()) return;
  $("#demoDock").classList.add("hidden");
}

function setDemoTab(tab) {
  if (tab === "event" && !confirmLeaveRecording()) return;
  $$("[data-demo-tab]").forEach((b) => b.classList.toggle("active", b.dataset.demoTab === tab));
  $("#demoLive").classList.toggle("hidden", tab !== "live");
  $("#demoEventForm").classList.toggle("hidden", tab !== "event");
}

async function addManualEvent(e) {
  e.preventDefault();
  const message = $("#demoEventMsg");
  const button = $("#demoEventForm button[type='submit']");
  button.disabled = true;
  message.textContent = "";
  try {
    let cameraId = $("#demoEventCamera").value;
    if (cameraId === "demo") cameraId = (await ensureDemoCamera()).id;
    const confidence = $("#demoEventConf").value;
    const when = $("#demoEventTime").value;
    await apiRequest(
      `/cameras/${cameraId}/events`,
      postJson({
        event_type: $("#demoEventType").value,
        person_label: $("#demoEventPerson").value.trim() || "Unknown person",
        confidence: confidence === "" ? null : Math.min(100, Math.max(0, Number(confidence))) / 100,
        details: $("#demoEventDetails").value.trim() || "Added manually from the camera simulator.",
        timestamp: when ? new Date(when).toISOString() : null,
      }),
    );
    message.textContent = "Event added. It now appears on Events & timeline and in the stats.";
    $("#demoEventDetails").value = "";
    await loadBackendEvents({ silent: true });
    await openDemoDock(); // refresh the camera list (the demo camera may be new) and the time
  } catch (error) {
    message.textContent = `Could not add the event: ${error.message}`;
  } finally {
    button.disabled = false;
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
  $("#hourlyList").addEventListener("click", (e) => {
    const row = e.target.closest(".hour-row");
    if (row) selectHour(Number(row.dataset.hour));
  });
  $("#deleteRecordingBtn").addEventListener("click", openDeleteRecording);
  $("#modalContent").addEventListener("submit", (e) => {
    const form = e.target.closest("#deleteRecordingForm");
    if (!form) return;
    e.preventDefault();
    submitDeleteRecording(form);
  });
  $("#downloadInfoBtn").addEventListener("click", () => {
    const h = archiveHours[selectedHour];
    const recording = h?.recordings?.[0];
    if (!recording) {
      showToast("No video was recorded for this hour.");
      return;
    }
    const mb = recording.size_bytes ? `${(recording.size_bytes / 1048576).toFixed(1)} MB` : "—";
    openModal(
      "Recording details",
      `<p><strong>File:</strong> ${escapeHtml(recording.filename)}</p>
       <p><strong>Camera:</strong> ${escapeHtml($("#archiveCamera").selectedOptions[0]?.textContent || "")}</p>
       <p><strong>Date:</strong> ${escapeHtml($("#archiveDate").value)}</p>
       <p><strong>Hour:</strong> ${escapeHtml(h.label)}</p>
       <p><strong>Size:</strong> ${mb} · ${escapeHtml(recording.format || "video")}</p>
       ${h.older ? `<p class="muted">${h.older} older file${h.older === 1 ? " is" : "s are"} also saved for this hour. Only the newest is shown.</p>` : ""}
       <button class="primary-btn close-modal-action" type="button">Close details</button>`,
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
  $("#notificationBtn").addEventListener("click", () => {
    if ($("#demoDock").classList.contains("hidden")) openDemoDock();
    else closeDemoDock();
  });
  $("#demoCloseBtn").addEventListener("click", closeDemoDock);
  $$("[data-demo-tab]").forEach((b) => b.addEventListener("click", () => setDemoTab(b.dataset.demoTab)));
  $("#demoStartBtn").addEventListener("click", startDemoCamera);
  window.addEventListener("beforeunload", (event) => {
    if (!demo.stream) return;
    event.preventDefault(); // browser shows its own "leave site?" prompt
    event.returnValue = "";
  });
  $("#demoStopBtn").addEventListener("click", () => stopDemoCamera());
  $("#demoEventForm").addEventListener("submit", addManualEvent);
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
    const remembered = sessionStorage.getItem("sentinel-page");
    const startPage = remembered && $(`#page-${remembered}`) ? remembered : "overview";
    apiRequest("/auth/me").then((user) => showApp(user, startPage)).catch(() => endSession());
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