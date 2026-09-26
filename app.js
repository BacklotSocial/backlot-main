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

// URL of the Cloudflare Worker from /functions/worker.js (README explains deploying it).
const WORKER_URL = "https://backlot-worker.YOUR-SUBDOMAIN.workers.dev/generate-reply";

// Seed cast, used only the very first time the `characters` collection is empty.
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

// Client-side content guardrails (a real gate still lives in Firestore rules + the Worker).
const MAX_POST_LENGTH = 500;
const POST_COOLDOWN_MS = 15000; // 15s between posts, per browser
const BANNED_WORDS = [
  // add terms you want to block client-side before anything reaches the network
];
const MAX_CHARACTER_REPLIES_PER_POST = 2;
const MAX_TOP_LEVEL_POSTS = 50;

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
  getDoc,
  updateDoc,
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

let currentUser = null;
let characters = []; // from Firestore
let usersByHandle = new Map(); // handle -> { uid, displayName }
const postElements = new Map(); // postId -> { el, childrenEl, data }

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
    name.textContent = currentUser.displayName || currentUser.email || "Signed in";
    const out = document.createElement("button");
    out.className = "btn-text";
    out.textContent = "Sign out";
    out.onclick = () => signOut(auth);
    chip.append(img, name, out);
    authArea.appendChild(chip);
  } else {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = "Sign in with Google";
    btn.onclick = doSignIn;
    authArea.appendChild(btn);
  }
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
  return base || `user${uid.slice(0, 6)}`;
}

async function ensureUserDoc(user) {
  const handle = slugifyHandle(user.displayName, user.uid);
  await setDoc(
    doc(db, "users", user.uid),
    {
      displayName: user.displayName || "Anonymous",
      handle,
      photoURL: user.photoURL || null,
    },
    { merge: true }
  );
}

onSnapshot(collection(db, "users"), (snap) => {
  const next = new Map();
  snap.forEach((d) => {
    const data = d.data();
    if (data.handle) next.set(data.handle.toLowerCase(), { uid: d.id, displayName: data.displayName });
  });
  usersByHandle = next;
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

function initials(name) {
  return (name || "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

onSnapshot(collection(db, "characters"), (snap) => {
  characters = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  castList.innerHTML = "";
  characters.forEach((c) => {
    const li = document.createElement("li");
    li.className = "cast-item";
    li.innerHTML = `
      <div class="avatar" style="background:${c.avatarColor}">${initials(c.name)}</div>
      <div>
        <span class="cast-name">${escapeHtml(c.name)}</span>
        <span class="cast-persona">${escapeHtml(c.persona.split(".")[0])}.</span>
      </div>
    `;
    castList.appendChild(li);
  });
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

function renderThreadNode(post, container, depth, insertAtTop) {
  if (postElements.has(post.id)) return postElements.get(post.id).el;

  const isReply = depth > 0;
  const el = document.createElement("article");
  el.className = isReply ? "post reply" : "post";
  el.dataset.postId = post.id;

  const color = post.authorType === "character" ? colorForCharacter(post.authorId) : "#372c4d";

  el.innerHTML = `
    <div class="post-head">
      <div class="avatar" style="background:${color}">${initials(post.authorName)}</div>
      <span class="post-name">${escapeHtml(post.authorName || "Unknown")}</span>
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
  el.querySelector('[data-action="reply"]').addEventListener("click", () => {
    toggleInlineReply(replySlot, post);
  });

  postElements.set(post.id, { el, childrenEl, data: post });

  if (insertAtTop) {
    container.insertBefore(el, container.firstChild);
  } else {
    container.appendChild(el);
  }

  // listen for direct children of this post (works recursively at any depth)
  const childQuery = query(
    collection(db, "posts"),
    where("parentId", "==", post.id),
    orderBy("createdAt", "asc")
  );
  onSnapshot(childQuery, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type !== "added") return;
      const child = { id: change.doc.id, ...change.doc.data() };
      renderThreadNode(child, childrenEl, depth + 1, false);
    });
  });

  return el;
}

function colorForCharacter(id) {
  const c = characters.find((c) => c.id === id);
  return c ? c.avatarColor : "#372c4d";
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
      await submitPost(text, post.id, {
        authorType: post.authorType,
        authorId: post.authorId,
        authorName: post.authorName,
      });
      slot.innerHTML = "";
    } catch (err) {
      console.error(err);
      note.textContent = "Couldn't post that — try again.";
    }
  };
  slot.appendChild(wrap);
  textarea.focus();
}

// live-updating relative timestamps
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function renderTextWithMentions(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/(^|\s)@([a-z0-9_]{2,20})/gi, (whole, pre, handle) => {
    if (usersByHandle.has(handle.toLowerCase())) {
      return `${pre}<span class="mention">@${handle}</span>`;
    }
    return whole;
  });
}

function extractMentionedUsers(text, excludeUid) {
  const found = new Map();
  const re = /(^|\s)@([a-z0-9_]{2,20})/gi;
  let m;
  while ((m = re.exec(text))) {
    const entry = usersByHandle.get(m[2].toLowerCase());
    if (entry && entry.uid !== excludeUid) found.set(entry.uid, entry);
  }
  return [...found.values()];
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

/**
 * Creates a post (top-level if parentId is null, otherwise a threaded reply),
 * fires notifications, and gives the cast a chance to jump in.
 */
async function submitPost(text, parentId, parentAuthorInfo) {
  const postRef = await addDoc(collection(db, "posts"), {
    authorType: "user",
    authorId: currentUser.uid,
    authorName: currentUser.displayName || "Anonymous",
    text,
    parentId,
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

  // notify the person being replied to
  if (parentAuthorInfo && parentAuthorInfo.authorType === "user") {
    const isSelfReply = authorType === "user" && authorId === parentAuthorInfo.authorId;
    if (!isSelfReply) {
      jobs.push(
        createNotification(parentAuthorInfo.authorId, {
          type: "reply",
          fromName: authorName,
          snippet: text,
          sourcePostId: postId,
        })
      );
    }
  }

  // notify anyone @mentioned
  const mentioned = extractMentionedUsers(text, authorType === "user" ? authorId : null);
  mentioned.forEach((u) => {
    jobs.push(
      createNotification(u.uid, {
        type: "mention",
        fromName: authorName,
        snippet: text,
        sourcePostId: postId,
      })
    );
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
  const q = query(
    collection(db, "notifications"),
    where("toUserId", "==", uid),
    orderBy("createdAt", "desc"),
    limit(30)
  );
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

notifBtn.addEventListener("click", () => {
  notifPanel.hidden = !notifPanel.hidden;
});
document.addEventListener("click", (e) => {
  if (!notifPanel.hidden && !e.target.closest(".notif-wrap")) {
    notifPanel.hidden = true;
  }
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

  // walk up to the top-level ancestor so the whole thread renders
  let root = current;
  while (root.parentId) {
    const parentSnap = await getDoc(doc(db, "posts", root.parentId));
    if (!parentSnap.exists()) break;
    root = { id: parentSnap.id, ...parentSnap.data() };
  }

  if (!postElements.has(root.id)) {
    renderThreadNode(root, feed, 0, true);
  }

  waitThenScroll(postId, 0);
}

function waitThenScroll(postId, attempt) {
  if (postElements.has(postId)) {
    scrollAndHighlight(postId);
    return;
  }
  if (attempt > 20) return; // ~3s of trying, then give up quietly
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
    askCharacter(character, postId, postText, parentAuthorInfo); // fire and forget
  }
}

async function askCharacter(character, postId, originalText, parentAuthorInfo) {
  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken,
        characterName: character.name,
        persona: character.persona,
        postText: originalText,
      }),
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
