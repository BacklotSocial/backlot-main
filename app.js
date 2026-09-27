// ============================================================
// CONFIG — fill these in before deploying. See README.md.
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyBDtgv6RsdcSr4Kh3Gc91qNt7iw-n4vkkg",
  authDomain: "backlot-297a9.firebaseapp.com",
  projectId: "backlot-297a9",
  storageBucket: "backlot-297a9.firebasestorage.app",
  messagingSenderId: "974601219948",
  appId: "1:974601219948:web:51b89ac66b79618c248d49"
};

const WORKER_URL = "https://backlot-worker.backlotsocial.workers.dev/generate-reply";

// Seed cast. `id` doubles as the character's handle (@mara, @juno, @walt).
const SEED_CHARACTERS = [
  {
    id: "mara",
    name: "Mara Quinn",
    avatarColor: "#8b5cf6",
    persona:
      "A skeptical night-shift radio host. Dry, world-weary wit, never earnest. " +
      "Replies in under 40 words, no exclamation points, never breaks character or mentions being an AI.",
    replyChance: 0.6,
  },
  {
    id: "juno",
    name: "Juno Ferro",
    avatarColor: "#c4b5fd",
    persona:
      "An overly enthusiastic amateur inventor who relates everything to some half-finished gadget. " +
      "Warm and a little rambling. Replies in under 40 words, never breaks character or mentions being an AI.",
    replyChance: 0.5,
  },
  {
    id: "walt",
    name: "Walt Okafor",
    avatarColor: "#f0729a",
    persona:
      "A retired ship mechanic who gives blunt, practical opinions whether asked or not. " +
      "Short sentences. Replies in under 40 words, never breaks character or mentions being an AI.",
    replyChance: 0.4,
  },
];

const MAX_POST_LENGTH = 500;
const POST_COOLDOWN_MS = 15000; // 15s between posts, per browser
const BANNED_WORDS = [];
const MAX_CHARACTER_REPLIES_PER_POST = 2;
const MAX_TOP_LEVEL_POSTS = 50;
const IDENTITY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HANDLE_PATTERN = /^[a-z0-9_]{2,20}$/;
const BIO_MAX_LENGTH = 160; // unlike name/handle, bio has no cooldown — edit as often as you like

// ============================================================
// Firebase setup
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  setDoc,
  updateDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

// ============================================================
// DOM refs
// ============================================================

const authArea = document.getElementById("authArea");
const composer = document.getElementById("composer");
const postText = document.getElementById("postText");
const postBtn = document.getElementById("postBtn");
const charCount = document.getElementById("charCount");
const composerNote = document.getElementById("composerNote");
const castList = document.getElementById("castList");
const feed = document.getElementById("feed");
const feedEmpty = document.getElementById("feedEmpty");
const notifBtn = document.getElementById("notifBtn");
const notifBadge = document.getElementById("notifBadge");
const notifPanel = document.getElementById("notifPanel");
const notifList = document.getElementById("notifList");
const notifEmpty = document.getElementById("notifEmpty");
const profilePopover = document.getElementById("profilePopover");
const profileClose = document.getElementById("profileClose");
const profileHeader = document.getElementById("profileHeader");
const profilePosts = document.getElementById("profilePosts");
const profileEmpty = document.getElementById("profileEmpty");
const modalRoot = document.getElementById("modalRoot");
const wordmarkLink = document.getElementById("wordmarkLink");

let currentUser = null;
let characters = [];
let usersByHandle = new Map(); // handle -> { uid, displayName, photoURL, ... }
let usersByUid = new Map(); // uid -> { handle, displayName, photoURL, ... }
const postElements = new Map(); // postId -> { el, childrenEl, data }
let profilePostsUnsub = null;
let currentProfileHandle = null;

// ============================================================
// Avatars — real Google photo when we have one, initials otherwise
// ============================================================

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Returns HTML for an avatar. If a photo URL is given, renders an <img class="avatar">
// that silently falls back to the initials/color version if the image fails to load
// (handled by the single delegated 'error' listener below — inline onerror isn't
// reliable once the src is escaped into an attribute).
function avatarMarkup(name, color, photoURL) {
  const label = initials(name);
  if (photoURL) {
    return `<img class="avatar" src="${escapeAttr(photoURL)}" alt="" data-fallback-initials="${escapeAttr(label)}" data-fallback-color="${escapeAttr(color)}" />`;
  }
  return `<div class="avatar" style="background:${color}">${label}</div>`;
}

// 'error' events on <img> don't bubble, so this needs the capture phase.
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || !img.classList.contains("avatar")) return;
    const div = document.createElement("div");
    div.className = "avatar";
    div.style.background = img.dataset.fallbackColor || "#372c4d";
    div.textContent = img.dataset.fallbackInitials || "?";
    img.replaceWith(div);
  },
  true
);

// ============================================================
// Auth
// ============================================================

function renderAuthArea() {
  authArea.innerHTML = "";
  if (currentUser) {
    const chip = document.createElement("div");
    chip.className = "user-chip";
    const img = document.createElement("img");
    img.src = currentUser.photoURL || "";
    img.alt = "";
    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = currentUser.displayName || currentUser.email || "Signed in";
    name.onclick = () => {
      const mine = usersByUid.get(currentUser.uid);
      if (mine) navigateToProfile(mine.handle);
    };
    const handleSpan = document.createElement("span");
    handleSpan.className = "chip-handle";
    const out = document.createElement("button");
    out.className = "btn-text";
    out.textContent = "Sign out";
    out.onclick = () => signOut(auth);
    chip.append(img, name, handleSpan, out);
    authArea.appendChild(chip);
    updateChipHandle();
  } else {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = "Sign in with Google";
    btn.onclick = doSignIn;
    authArea.appendChild(btn);
  }
}

function updateChipHandle() {
  const span = document.querySelector(".chip-handle");
  if (!span || !currentUser) return;
  const mine = usersByUid.get(currentUser.uid);
  span.textContent = mine ? `@${mine.handle}` : "";
}

function doSignIn() {
  return signInWithPopup(auth, provider).catch((err) => {
    console.error(err);
    alert("Sign-in failed: " + err.message);
  });
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  renderAuthArea();
  postText.disabled = !user;
  postBtn.disabled = !user;
  if (user) {
    await ensureUserDoc(user);
    await ensureCharactersSeeded();
    listenForNotifications(user.uid);
  } else {
    notifBadge.hidden = true;
    notifList.innerHTML = "";
    notifEmpty.hidden = false;
  }
});

function slugifyHandle(name, uid) {
  const base = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
  return base.length >= 2 ? base : `user${uid.slice(0, 6)}`;
}

async function ensureUserDoc(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      displayName: user.displayName || "Anonymous",
      handle: slugifyHandle(user.displayName, user.uid),
      photoURL: user.photoURL || null,
      bio: "",
      createdAt: serverTimestamp(),
      lastNameChangeAt: serverTimestamp(),
    });
  } else {
    const data = snap.data();
    const patch = { photoURL: user.photoURL || null }; // photo refreshes freely on every sign-in
    if (!data.createdAt) patch.createdAt = serverTimestamp(); // backfill for pre-existing accounts
    await setDoc(ref, patch, { merge: true });
  }
}

onSnapshot(collection(db, "users"), (snap) => {
  const byHandle = new Map();
  const byUid = new Map();
  snap.forEach((d) => {
    const data = { uid: d.id, ...d.data() };
    if (data.handle) byHandle.set(data.handle.toLowerCase(), data);
    byUid.set(d.id, data);
  });
  usersByHandle = byHandle;
  usersByUid = byUid;
  if (currentUser) updateChipHandle();
  document.querySelectorAll(".post[data-post-id]").forEach(refreshPostHeadDisplay);
  if (currentProfileHandle) renderProfileFor(currentProfileHandle);
});

// ============================================================
// Characters (cast rail)
// ============================================================

async function ensureCharactersSeeded() {
  const snap = await getDocs(collection(db, "characters"));
  if (!snap.empty) return;
  await Promise.all(
    SEED_CHARACTERS.map((c) =>
      setDoc(doc(db, "characters", c.id), {
        name: c.name,
        avatarColor: c.avatarColor,
        persona: c.persona,
        replyChance: c.replyChance,
        active: true,
      })
    )
  );
}

onSnapshot(collection(db, "characters"), (snap) => {
  characters = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  castList.innerHTML = "";
  characters.forEach((c) => {
    const li = document.createElement("li");
    li.className = "cast-item";
    li.innerHTML = `
      ${avatarMarkup(c.name, c.avatarColor, null)}
      <div>
        <span class="cast-name">${escapeHtml(c.name)}</span>
        <span class="cast-handle">@${c.id}</span>
        <span class="cast-persona">${escapeHtml(c.persona.split(".")[0])}.</span>
      </div>
    `;
    li.onclick = () => navigateToProfile(c.id);
    castList.appendChild(li);
  });
  if (currentProfileHandle) renderProfileFor(currentProfileHandle);
});

// ============================================================
// Mention resolution (users + characters share one @handle space)
// ============================================================

function resolveMentionable(handleLower) {
  const u = usersByHandle.get(handleLower);
  if (u) return { type: "user", id: u.uid, displayName: u.displayName, handle: u.handle, photoURL: u.photoURL };
  const c = characters.find((c) => c.id.toLowerCase() === handleLower);
  if (c) return { type: "character", id: c.id, displayName: c.name, handle: c.id };
  return null;
}

function renderTextWithMentions(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/(^|\s)@([a-z0-9_]{2,20})/gi, (whole, pre, handle) => {
    const entry = resolveMentionable(handle.toLowerCase());
    if (entry) return `${pre}<span class="mention" data-goto-handle="${entry.handle}">@${handle}</span>`;
    return whole;
  });
}

function extractMentionedUsers(text, excludeUid) {
  const found = new Map();
  const re = /(^|\s)@([a-z0-9_]{2,20})/gi;
  let m;
  while ((m = re.exec(text))) {
    const entry = resolveMentionable(m[2].toLowerCase());
    if (entry && entry.type === "user" && entry.id !== excludeUid) found.set(entry.id, entry);
  }
  return [...found.values()];
}

// clicking any rendered @mention navigates to that profile
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-goto-handle]");
  if (el) navigateToProfile(el.dataset.gotoHandle);
});

// ============================================================
// Feed — one flat stream, threaded replies rendered inline
// ============================================================

const topLevelQuery = query(
  collection(db, "posts"),
  where("parentId", "==", null),
  orderBy("createdAt", "desc"),
  limit(MAX_TOP_LEVEL_POSTS)
);

onSnapshot(topLevelQuery, (snap) => {
  feedEmpty.hidden = snap.size > 0;
  snap.docChanges().forEach((change) => {
    if (change.type !== "added") return;
    const post = { id: change.doc.id, ...change.doc.data() };
    renderThreadNode(post, feed, 0, true);
  });
});

function authorInfoFor(post) {
  if (post.authorType === "character") {
    const c = characters.find((c) => c.id === post.authorId);
    return { handle: post.authorId, color: c ? c.avatarColor : "#372c4d", photoURL: null };
  }
  const u = usersByUid.get(post.authorId);
  return { handle: u ? u.handle : null, color: "#372c4d", photoURL: u ? u.photoURL : null };
}

function renderThreadNode(post, container, depth, insertAtTop) {
  if (postElements.has(post.id)) return postElements.get(post.id).el;

  const isReply = depth > 0;
  const el = document.createElement("article");
  el.className = isReply ? "post reply" : "post";
  el.dataset.postId = post.id;

  const info = authorInfoFor(post);

  el.innerHTML = `
    <div class="post-head">
      <span data-role="avatar-slot">${avatarMarkup(post.authorName, info.color, info.photoURL)}</span>
      <span class="post-name" data-role="name">${escapeHtml(post.authorName || "Unknown")}</span>
      <span class="post-handle" data-role="handle">${info.handle ? "@" + escapeHtml(info.handle) : ""}</span>
      <span class="post-time" data-time>${formatTime(post.createdAt)}</span>
    </div>
    <p class="post-text">${renderTextWithMentions(post.text)}</p>
    <div class="post-actions">
      <button class="btn-text" data-action="reply">Reply</button>
    </div>
    <div class="reply-slot"></div>
    <div class="thread-children"></div>
  `;

  const childrenEl = el.querySelector(".thread-children");
  const replySlot = el.querySelector(".reply-slot");
  el.querySelector('[data-action="reply"]').addEventListener("click", () => toggleInlineReply(replySlot, post));

  const goToAuthor = () => {
    if (info.handle) navigateToProfile(info.handle);
  };
  el.querySelector('[data-role="name"]').addEventListener("click", goToAuthor);
  el.querySelector('[data-role="handle"]').addEventListener("click", goToAuthor);

  postElements.set(post.id, { el, childrenEl, data: post });

  if (insertAtTop) container.insertBefore(el, container.firstChild);
  else container.appendChild(el);

  const childQuery = query(collection(db, "posts"), where("parentId", "==", post.id), orderBy("createdAt", "asc"));
  onSnapshot(childQuery, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type !== "added") return;
      const child = { id: change.doc.id, ...change.doc.data() };
      renderThreadNode(child, childrenEl, depth + 1, false);
    });
  });

  return el;
}

// re-render a post's avatar/handle once the users collection catches up
// (handles a fresh sign-up whose post rendered before their user doc arrived)
function refreshPostHeadDisplay(el) {
  const entry = postElements.get(el.dataset.postId);
  if (!entry) return;
  const info = authorInfoFor(entry.data);
  const handleEl = el.querySelector('[data-role="handle"]');
  if (handleEl) handleEl.textContent = info.handle ? `@${info.handle}` : "";
  const slot = el.querySelector('[data-role="avatar-slot"]');
  if (slot && slot.firstElementChild && slot.firstElementChild.tagName !== "IMG" && info.photoURL) {
    slot.innerHTML = avatarMarkup(entry.data.authorName, info.color, info.photoURL);
  }
}

function toggleInlineReply(slot, post) {
  if (slot.childNodes.length) {
    slot.innerHTML = "";
    return;
  }
  if (!currentUser) {
    doSignIn();
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "inline-reply";
  wrap.innerHTML = `
    <textarea rows="2" maxlength="${MAX_POST_LENGTH}" placeholder="Reply to ${escapeHtml(post.authorName)}…"></textarea>
    <div class="inline-reply-row">
      <button class="btn-text" data-action="cancel">Cancel</button>
      <button class="btn btn-primary" data-action="send">Reply</button>
    </div>
    <p class="composer-note" data-note></p>
  `;
  const textarea = wrap.querySelector("textarea");
  const note = wrap.querySelector("[data-note]");
  wrap.querySelector('[data-action="cancel"]').onclick = () => (slot.innerHTML = "");
  wrap.querySelector('[data-action="send"]').onclick = async () => {
    const text = textarea.value.trim();
    const error = validatePost(text);
    if (error) {
      note.textContent = error;
      return;
    }
    note.textContent = "";
    try {
      await submitPost(text, post.id, { authorType: post.authorType, authorId: post.authorId, authorName: post.authorName });
      slot.innerHTML = "";
    } catch (err) {
      console.error(err);
      note.textContent = "Couldn't post that — try again.";
    }
  };
  slot.appendChild(wrap);
  textarea.focus();
}

setInterval(() => {
  document.querySelectorAll("[data-time]").forEach((elm) => {
    const entry = [...postElements.values()].find((p) => p.el.contains(elm));
    if (entry) elm.textContent = formatTime(entry.data.createdAt);
  });
}, 30000);

function formatTime(ts) {
  if (!ts || !ts.toDate) return "just now";
  const diffMs = Date.now() - ts.toDate().getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return ts.toDate().toLocaleDateString();
}

function formatDate(ts) {
  if (!ts || !ts.toDate) return "recently";
  return ts.toDate().toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ============================================================
// Composer + content checks
// ============================================================

postText.addEventListener("input", () => {
  charCount.textContent = `${postText.value.length} / ${MAX_POST_LENGTH}`;
});

function validatePost(text) {
  if (!text.trim()) return "Write something first.";
  if (text.length > MAX_POST_LENGTH) return `Keep it under ${MAX_POST_LENGTH} characters.`;
  const lower = text.toLowerCase();
  if (BANNED_WORDS.some((w) => w && lower.includes(w.toLowerCase()))) {
    return "That post contains a word this board doesn't allow.";
  }
  const lastPostAt = Number(localStorage.getItem("backlot:lastPostAt") || 0);
  if (Date.now() - lastPostAt < POST_COOLDOWN_MS) {
    const waitS = Math.ceil((POST_COOLDOWN_MS - (Date.now() - lastPostAt)) / 1000);
    return `Wait ${waitS}s before posting again.`;
  }
  return null;
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const text = postText.value.trim();
  const error = validatePost(text);
  if (error) {
    composerNote.textContent = error;
    return;
  }
  composerNote.textContent = "";
  postBtn.disabled = true;
  try {
    await submitPost(text, null, null);
    postText.value = "";
    charCount.textContent = `0 / ${MAX_POST_LENGTH}`;
  } catch (err) {
    console.error(err);
    composerNote.textContent = "Couldn't post that — try again.";
  } finally {
    postBtn.disabled = false;
  }
});

async function submitPost(text, parentId, parentAuthorInfo) {
  const postRef = await addDoc(collection(db, "posts"), {
    authorType: "user",
    authorId: currentUser.uid,
    authorName: currentUser.displayName || "Anonymous",
    text,
    parentId,
    parentAuthorName: parentAuthorInfo ? parentAuthorInfo.authorName : null,
    createdAt: serverTimestamp(),
  });
  localStorage.setItem("backlot:lastPostAt", String(Date.now()));

  await afterPostCreated({
    postId: postRef.id,
    text,
    authorType: "user",
    authorId: currentUser.uid,
    authorName: currentUser.displayName || "Anonymous",
    parentAuthorInfo,
  });

  triggerCharacterReplies(postRef.id, text, {
    authorType: "user",
    authorId: currentUser.uid,
    authorName: currentUser.displayName || "Anonymous",
  });

  return postRef;
}

// ============================================================
// Notifications
// ============================================================

async function afterPostCreated({ postId, text, authorType, authorId, authorName, parentAuthorInfo }) {
  const jobs = [];

  if (parentAuthorInfo && parentAuthorInfo.authorType === "user") {
    const isSelfReply = authorType === "user" && authorId === parentAuthorInfo.authorId;
    if (!isSelfReply) {
      jobs.push(createNotification(parentAuthorInfo.authorId, { type: "reply", fromName: authorName, snippet: text, sourcePostId: postId }));
    }
  }

  const mentioned = extractMentionedUsers(text, authorType === "user" ? authorId : null);
  mentioned.forEach((u) => {
    jobs.push(createNotification(u.id, { type: "mention", fromName: authorName, snippet: text, sourcePostId: postId }));
  });

  await Promise.all(jobs);
}

async function createNotification(toUserId, { type, fromName, snippet, sourcePostId }) {
  await addDoc(collection(db, "notifications"), {
    toUserId,
    type,
    fromName,
    snippet: snippet.slice(0, 140),
    sourcePostId,
    createdAt: serverTimestamp(),
    read: false,
  });
}

let notifUnsub = null;
let latestNotifs = [];

function listenForNotifications(uid) {
  if (notifUnsub) notifUnsub();
  const q = query(collection(db, "notifications"), where("toUserId", "==", uid), orderBy("createdAt", "desc"), limit(30));
  notifUnsub = onSnapshot(q, (snap) => {
    latestNotifs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderNotifications();
  });
}

function renderNotifications() {
  const unread = latestNotifs.filter((n) => !n.read).length;
  notifBadge.hidden = unread === 0;
  notifBadge.textContent = unread > 9 ? "9+" : String(unread);
  notifEmpty.hidden = latestNotifs.length > 0;
  notifList.innerHTML = "";
  latestNotifs.forEach((n) => {
    const btn = document.createElement("button");
    btn.className = "notif-item" + (n.read ? "" : " unread");
    const verb = n.type === "mention" ? "mentioned you" : "replied to you";
    btn.innerHTML = `
      <div class="avatar" style="background:#372c4d">${initials(n.fromName)}</div>
      <div class="notif-body">
        <span class="notif-line"><b>${escapeHtml(n.fromName)}</b> ${verb}</span>
        <span class="notif-snippet">${escapeHtml(n.snippet)}</span>
        <span class="notif-time">${formatTime(n.createdAt)}</span>
      </div>
    `;
    btn.onclick = () => {
      markNotificationRead(n);
      notifPanel.hidden = true;
      closeProfilePopover();
      jumpToPost(n.sourcePostId);
    };
    notifList.appendChild(btn);
  });
}

async function markNotificationRead(n) {
  if (n.read) return;
  try {
    await updateDoc(doc(db, "notifications", n.id), { read: true });
  } catch (err) {
    console.error(err);
  }
}

notifBtn.addEventListener("click", () => (notifPanel.hidden = !notifPanel.hidden));
document.addEventListener("click", (e) => {
  if (!notifPanel.hidden && !e.target.closest(".notif-wrap")) notifPanel.hidden = true;
});

// ============================================================
// Jump to a post from a notification, loading its thread if needed
// ============================================================

async function jumpToPost(postId) {
  if (postElements.has(postId)) {
    scrollAndHighlight(postId);
    return;
  }
  let current;
  try {
    const snap = await getDoc(doc(db, "posts", postId));
    if (!snap.exists()) return;
    current = { id: snap.id, ...snap.data() };
  } catch (err) {
    console.error(err);
    return;
  }
  let root = current;
  while (root.parentId) {
    const parentSnap = await getDoc(doc(db, "posts", root.parentId));
    if (!parentSnap.exists()) break;
    root = { id: parentSnap.id, ...parentSnap.data() };
  }
  if (!postElements.has(root.id)) renderThreadNode(root, feed, 0, true);
  waitThenScroll(postId, 0);
}

function waitThenScroll(postId, attempt) {
  if (postElements.has(postId)) {
    scrollAndHighlight(postId);
    return;
  }
  if (attempt > 20) return;
  setTimeout(() => waitThenScroll(postId, attempt + 1), 150);
}

function scrollAndHighlight(postId) {
  const entry = postElements.get(postId);
  if (!entry) return;
  entry.el.scrollIntoView({ behavior: "smooth", block: "center" });
  entry.el.classList.add("highlight");
  setTimeout(() => entry.el.classList.remove("highlight"), 1800);
}

// ============================================================
// Profile popout — floats under the header, feed always stays visible
// ============================================================

function openProfilePopover(handle) {
  currentProfileHandle = handle.toLowerCase();
  profilePopover.hidden = false;
  renderProfileFor(currentProfileHandle);
}

function closeProfilePopover() {
  if (profilePopover.hidden) return;
  currentProfileHandle = null;
  profilePopover.hidden = true;
  if (profilePostsUnsub) {
    profilePostsUnsub();
    profilePostsUnsub = null;
  }
  if (location.hash.startsWith("#/u/")) history.replaceState(null, "", location.pathname + location.search);
}

function navigateToProfile(handle) {
  location.hash = `#/u/${handle}`;
}

function parseRoute() {
  const m = location.hash.match(/^#\/u\/([a-z0-9_]{2,20})$/i);
  return m ? m[1].toLowerCase() : null;
}

function onRouteChange() {
  const handle = parseRoute();
  if (handle) openProfilePopover(handle);
  else closeProfilePopover();
}

window.addEventListener("hashchange", onRouteChange);
wordmarkLink.addEventListener("click", (e) => {
  e.preventDefault();
  location.hash = "";
});
profileClose.addEventListener("click", () => {
  location.hash = "";
});
document.addEventListener("click", (e) => {
  if (profilePopover.hidden) return;
  const insideTrigger = e.target.closest(
    "[data-goto-handle], .post-name, .post-handle, .cast-item, .chip-name, #profilePopover"
  );
  if (!insideTrigger) location.hash = "";
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !profilePopover.hidden) location.hash = "";
});

function renderProfileFor(handle) {
  const entry = resolveMentionable(handle);
  if (!entry) {
    profileHeader.innerHTML = `<p class="feed-empty">Nobody here goes by @${escapeHtml(handle)}.</p>`;
    profilePosts.innerHTML = "";
    profileEmpty.hidden = true;
    return;
  }

  const isCharacter = entry.type === "character";
  const isMe = !isCharacter && currentUser && entry.id === currentUser.uid;
  const color = isCharacter ? (characters.find((c) => c.id === entry.id) || {}).avatarColor : "#372c4d";
  const userDoc = isCharacter ? null : usersByUid.get(entry.id);
  const character = isCharacter ? characters.find((c) => c.id === entry.id) : null;

  profileHeader.innerHTML = `
    <div class="profile-avatar-row">
      ${avatarMarkup(entry.displayName, color, entry.photoURL)}
      <div>
        <div class="profile-name">${escapeHtml(entry.displayName)}</div>
        <div class="profile-handle">@${escapeHtml(entry.handle)}</div>
      </div>
    </div>
    ${(() => {
      const bioText = isCharacter ? character.persona : (userDoc && userDoc.bio ? userDoc.bio : "");
      return bioText ? `<p class="profile-bio">${escapeHtml(bioText)}</p>` : "";
    })()}
    <p class="profile-meta">${isCharacter ? "A resident of Backlot" : `Joined ${formatDate(userDoc && userDoc.createdAt)}`}</p>
    <div class="profile-actions" data-actions></div>
  `;

  if (isMe) {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = "Edit name & handle";
    btn.onclick = () => openEditModal(userDoc);
    profileHeader.querySelector("[data-actions]").appendChild(btn);
  }

  if (profilePostsUnsub) profilePostsUnsub();
  const q = query(collection(db, "posts"), where("authorId", "==", entry.id), orderBy("createdAt", "desc"), limit(50));
  profilePostsUnsub = onSnapshot(q, (snap) => {
    profileEmpty.hidden = snap.size > 0;
    profilePosts.innerHTML = "";
    snap.forEach((d) => renderProfilePost({ id: d.id, ...d.data() }));
  });
}

function renderProfilePost(post) {
  const el = document.createElement("article");
  el.className = "post";
  el.innerHTML = `
    ${post.parentId ? `<p class="profile-post-reply-hint">Replying to ${escapeHtml(post.parentAuthorName || "a post")}</p>` : ""}
    <p class="post-text">${renderTextWithMentions(post.text)}</p>
    <div class="post-head" style="margin-top:6px;">
      <span class="post-time">${formatTime(post.createdAt)}</span>
    </div>
    <div class="profile-post-actions">
      <button class="btn-text" data-action="view">View in feed →</button>
    </div>
  `;
  el.querySelector('[data-action="view"]').onclick = () => {
    location.hash = "";
    setTimeout(() => jumpToPost(post.id), 60);
  };
  profilePosts.appendChild(el);
}

onRouteChange(); // handle a deep link on first load

// ============================================================
// Edit name & handle (7-day cooldown, enforced again server-side)
// ============================================================

function canChangeIdentity(userDoc) {
  if (!userDoc || !userDoc.lastNameChangeAt || !userDoc.lastNameChangeAt.toDate) return { allowed: true };
  const elapsed = Date.now() - userDoc.lastNameChangeAt.toDate().getTime();
  if (elapsed >= IDENTITY_COOLDOWN_MS) return { allowed: true };
  const daysLeft = Math.ceil((IDENTITY_COOLDOWN_MS - elapsed) / 86400000);
  return { allowed: false, daysLeft };
}

function openEditModal(userDoc) {
  const status = canChangeIdentity(userDoc);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h3>Edit name &amp; handle</h3>
      <label for="editName">Display name</label>
      <input type="text" id="editName" maxlength="40" value="${escapeAttr(userDoc?.displayName || "")}" ${status.allowed ? "" : "disabled"} />

      <label for="editHandle">Handle</label>
      <input type="text" id="editHandle" maxlength="20" value="${escapeAttr(userDoc?.handle || "")}" ${status.allowed ? "" : "disabled"} />
      <p class="modal-hint">Lowercase letters, numbers, underscores only. 2–20 characters.</p>

      ${status.allowed ? "" : `<p class="modal-hint">You can change these again in ${status.daysLeft} day${status.daysLeft === 1 ? "" : "s"}.</p>`}

      <label for="editBio">Bio</label>
      <textarea id="editBio" maxlength="${BIO_MAX_LENGTH}" rows="3">${escapeHtml(userDoc?.bio || "")}</textarea>
      <p class="modal-hint">${BIO_MAX_LENGTH} characters, edit as often as you like — no cooldown on this one.</p>

      <p class="modal-error" data-error></p>

      <div class="modal-row">
        <button class="btn-text" data-action="cancel">Cancel</button>
        <button class="btn btn-primary" data-action="save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-action="cancel"]').onclick = close;

  overlay.querySelector('[data-action="save"]').onclick = async () => {
    const nameInput = overlay.querySelector("#editName");
    const handleInput = overlay.querySelector("#editHandle");
    const bioInput = overlay.querySelector("#editBio");
    const errorEl = overlay.querySelector("[data-error]");
    const bio = bioInput.value.trim();

    const payload = {};
    if (bio !== (userDoc?.bio || "")) payload.bio = bio;

    if (status.allowed) {
      const displayName = nameInput.value.trim();
      const handle = handleInput.value.trim().toLowerCase();
      const identityChanged = displayName !== (userDoc?.displayName || "") || handle !== (userDoc?.handle || "");

      if (identityChanged) {
        if (!displayName) return (errorEl.textContent = "Display name can't be empty.");
        if (!HANDLE_PATTERN.test(handle)) return (errorEl.textContent = "Handle must be 2–20 lowercase letters, numbers, or underscores.");
        if (characters.some((c) => c.id.toLowerCase() === handle)) return (errorEl.textContent = "That handle belongs to a cast member.");

        errorEl.textContent = "Checking availability…";
        try {
          const existing = await getDocs(query(collection(db, "users"), where("handle", "==", handle)));
          const takenByOther = existing.docs.some((d) => d.id !== currentUser.uid);
          if (takenByOther) return (errorEl.textContent = "That handle's taken.");
        } catch (err) {
          console.error(err);
          return (errorEl.textContent = "Couldn't check that handle — try again.");
        }
        payload.displayName = displayName;
        payload.handle = handle;
        payload.lastNameChangeAt = serverTimestamp();
      }
    }

    if (Object.keys(payload).length === 0) {
      close();
      return;
    }

    errorEl.textContent = "";
    try {
      await updateDoc(doc(db, "users", currentUser.uid), payload);
      close();
      if (payload.handle) navigateToProfile(payload.handle);
    } catch (err) {
      console.error(err);
      errorEl.textContent = "Couldn't save — try again.";
    }
  };
}

// ============================================================
// AI character replies
// ============================================================

function triggerCharacterReplies(postId, postText, parentAuthorInfo) {
  const candidates = characters.filter((c) => c.active !== false);
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  let repliesSent = 0;
  for (const character of shuffled) {
    if (repliesSent >= MAX_CHARACTER_REPLIES_PER_POST) break;
    if (Math.random() > (character.replyChance ?? 0.5)) continue;
    repliesSent += 1;
    askCharacter(character, postId, postText, parentAuthorInfo);
  }
}

async function askCharacter(character, postId, originalText, parentAuthorInfo) {
  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, characterName: character.name, persona: character.persona, postText: originalText }),
    });
    if (!res.ok) throw new Error(`Worker returned ${res.status}`);
    const data = await res.json();
    const reply = (data.reply || "").trim();
    if (!reply) return;

    const replyRef = await addDoc(collection(db, "posts"), {
      authorType: "character",
      authorId: character.id,
      authorName: character.name,
      text: reply,
      parentId: postId,
      parentAuthorName: parentAuthorInfo ? parentAuthorInfo.authorName : null,
      createdAt: serverTimestamp(),
    });

    await afterPostCreated({
      postId: replyRef.id,
      text: reply,
      authorType: "character",
      authorId: character.id,
      authorName: character.name,
      parentAuthorInfo,
    });
  } catch (err) {
    console.error(`${character.name} failed to reply:`, err);
  }
}
