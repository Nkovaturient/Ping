/* Exam Fees Tracker — modular page logic for fees.html */

const FEE_DATA_URL = "./data/exam-fees.json";
const CATEGORY_IDS = ["general", "obc", "sc", "st", "ews", "pwd", "female"];

let feeData = null;
let state = {
  reservation: "general",
  portalCategory: "all",
  womenFreeOnly: false,
  search: "",
  compareIds: new Set(),
  timelineExamId: null,
};

const charts = { bar: null, pie: null, timeline: null };

async function loadFeeData() {
  const res = await fetch(FEE_DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load exam fee data");
  feeData = await res.json();
}

function formatFee(amount) {
  if (amount === 0) return "Free";
  if (amount == null) return "—";
  return "₹" + amount.toLocaleString("en-IN");
}

function getFeeForCategory(exam, categoryId) {
  const fees = exam.current?.fees;
  if (!fees) return null;
  return fees[categoryId] ?? fees.general ?? null;
}

function getFilteredExams() {
  if (!feeData) return [];
  return feeData.exams.filter((exam) => {
    if (state.portalCategory !== "all" && exam.category !== state.portalCategory) return false;
    if (state.womenFreeOnly && !exam.womenFree) return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = [exam.name, exam.shortName, exam.conductingBody, exam.portal].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderKpis(exams) {
  const freeCount = exams.filter((e) => getFeeForCategory(e, state.reservation) === 0).length;
  const paid = exams.filter((e) => {
    const f = getFeeForCategory(e, state.reservation);
    return f != null && f > 0;
  });
  const avgPaid = paid.length
    ? Math.round(paid.reduce((s, e) => s + getFeeForCategory(e, state.reservation), 0) / paid.length)
    : 0;
  const maxExam = paid.reduce(
    (best, e) => {
      const f = getFeeForCategory(e, state.reservation);
      return f > (best?.fee ?? -1) ? { exam: e, fee: f } : best;
    },
    null
  );

  document.getElementById("kpiTotal").textContent = exams.length;
  document.getElementById("kpiFree").textContent = freeCount;
  document.getElementById("kpiAvg").textContent = paid.length ? formatFee(avgPaid) : "—";
  document.getElementById("kpiMax").textContent = maxExam ? formatFee(maxExam.fee) : "—";
  document.getElementById("kpiMaxSub").textContent = maxExam ? maxExam.exam.shortName : "";
}

function renderCategoryBarChart(exams) {
  const canvas = document.getElementById("categoryBarChart");
  if (!canvas || typeof Chart === "undefined") return;

  const sorted = [...exams].sort(
    (a, b) => (getFeeForCategory(b, state.reservation) ?? 0) - (getFeeForCategory(a, state.reservation) ?? 0)
  );
  const top = sorted.slice(0, 12);
  const labels = top.map((e) => e.shortName);
  const values = top.map((e) => getFeeForCategory(e, state.reservation) ?? 0);
  const colors = values.map((v) => (v === 0 ? "rgba(34,180,110,0.75)" : "rgba(45,58,92,0.75)"));

  if (charts.bar) charts.bar.destroy();
  charts.bar = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Fee (₹)",
        data: values,
        backgroundColor: colors,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => (ctx.raw === 0 ? "Free" : "₹" + ctx.raw.toLocaleString("en-IN")),
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => (v === 0 ? "Free" : "₹" + v) },
        },
      },
    },
  });
}

function renderCategoryPie(exams) {
  const canvas = document.getElementById("categoryPieChart");
  if (!canvas || typeof Chart === "undefined") return;

  let free = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  for (const e of exams) {
    const f = getFeeForCategory(e, state.reservation) ?? 0;
    if (f === 0) free++;
    else if (f <= 150) low++;
    else if (f <= 500) mid++;
    else high++;
  }

  if (charts.pie) charts.pie.destroy();
  charts.pie = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["Free", "₹1–150", "₹151–500", "₹500+"],
      datasets: [{
        data: [free, low, mid, high],
        backgroundColor: [
          "rgba(34,180,110,0.8)",
          "rgba(219,154,52,0.75)",
          "rgba(45,58,92,0.65)",
          "rgba(185,28,28,0.65)",
        ],
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

function renderExamTable(exams) {
  const tbody = document.getElementById("examTableBody");
  if (!exams.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No exams match your filters.</td></tr>';
    return;
  }

  const catLabel = feeData.reservationCategories.find((c) => c.id === state.reservation)?.label || state.reservation;

  tbody.innerHTML = exams
    .map((exam) => {
      const fee = getFeeForCategory(exam, state.reservation);
      const feeClass = fee === 0 ? "fee-free" : "fee-paid";
      const feeText = formatFee(fee);
      const portalCat = feeData.portalCategories.find((c) => c.id === exam.category)?.label || exam.category;
      const checked = state.compareIds.has(exam.id) ? "checked" : "";
      const womenBadge = exam.womenFree ? '<span class="badge badge-free">Women free</span>' : "";
      return `<tr data-exam-id="${exam.id}">
        <td><input type="checkbox" class="compare-check" data-id="${exam.id}" ${checked} aria-label="Compare ${exam.shortName}"></td>
        <td><strong>${exam.shortName}</strong>${womenBadge}<br><span class="cat-tag">${portalCat}</span></td>
        <td>${exam.conductingBody}</td>
        <td class="${feeClass}">${feeText}</td>
        <td>${formatFee(exam.current?.fees?.general ?? null)}</td>
        <td>${exam.current?.year || "—"}</td>
        <td>${exam.current?.verifiedOn || "—"}</td>
      </tr>`;
    })
    .join("");

  document.getElementById("tableCaption").textContent =
    `Showing ${exams.length} exams · Your category: ${catLabel}`;

  tbody.querySelectorAll(".compare-check").forEach((cb) => {
    cb.addEventListener("change", (ev) => {
      const id = ev.target.dataset.id;
      if (ev.target.checked) {
        if (state.compareIds.size >= 5) {
          ev.target.checked = false;
          return;
        }
        state.compareIds.add(id);
      } else {
        state.compareIds.delete(id);
      }
      updateCompareButton();
    });
  });
}

function updateCompareButton() {
  const btn = document.getElementById("openCompareBtn");
  const n = state.compareIds.size;
  btn.disabled = n < 1;
  btn.textContent = n ? `Compare ${n} exam${n > 1 ? "s" : ""}` : "Compare selected";
}

function openCompareDrawer() {
  const drawer = document.getElementById("compareDrawer");
  const body = document.getElementById("compareBody");
  const exams = feeData.exams.filter((e) => state.compareIds.has(e.id));

  body.innerHTML = exams
    .map((exam) => {
      const rows = CATEGORY_IDS.map((cat) => {
        const label = feeData.reservationCategories.find((c) => c.id === cat)?.short || cat;
        const val = exam.current?.fees?.[cat];
        return `<div><span>${label}</span><strong>${formatFee(val ?? null)}</strong></div>`;
      }).join("");
      return `<div class="compare-item">
        <h4>${exam.name}</h4>
        <div class="compare-fee-grid">${rows}</div>
        ${exam.notes ? `<p style="margin:8px 0 0;font-size:11px;color:var(--ink-soft)">${exam.notes}</p>` : ""}
        <a href="${exam.current?.source || "#"}" target="_blank" rel="noopener" style="font-size:12px">Official source ↗</a>
      </div>`;
    })
    .join("");

  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
}

function closeCompareDrawer() {
  const drawer = document.getElementById("compareDrawer");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

function renderTimelineOptions() {
  const sel = document.getElementById("timelineExamSelect");
  const withHistory = feeData.exams.filter((e) => e.history && e.history.length);
  sel.innerHTML = withHistory
    .map((e) => `<option value="${e.id}">${e.shortName}</option>`)
    .join("");
  state.timelineExamId = withHistory[0]?.id || null;
  if (state.timelineExamId) sel.value = state.timelineExamId;
}

function renderTimelineChart() {
  const exam = feeData.exams.find((e) => e.id === state.timelineExamId);
  const canvas = document.getElementById("timelineChart");
  const gapEl = document.getElementById("timelineGapNote");
  if (!exam || !canvas) return;

  const points = (exam.history || [])
    .filter((h) => h.fees && h.verified !== false)
    .sort((a, b) => a.year - b.year);

  if (exam.current?.fees) {
    points.push({
      year: exam.current.year,
      fees: exam.current.fees,
      verified: true,
    });
  }

  const gaps = (exam.history || []).filter((h) => h.fees == null || h.verified === false);
  gapEl.textContent = gaps.length
    ? gaps.map((g) => `${g.year}: ${g.note || "Data gap"}`).join(" · ")
    : "";

  const labels = points.map((p) => String(p.year));
  const generalData = points.map((p) => p.fees?.general ?? null);
  const scData = points.map((p) => p.fees?.sc ?? null);

  if (charts.timeline) charts.timeline.destroy();
  charts.timeline = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "General",
          data: generalData,
          borderColor: "rgba(45,58,92,0.9)",
          backgroundColor: "rgba(45,58,92,0.1)",
          tension: 0.2,
          fill: true,
        },
        {
          label: "SC",
          data: scData,
          borderColor: "rgba(34,180,110,0.9)",
          backgroundColor: "rgba(34,180,110,0.08)",
          tension: 0.2,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw === 0 ? "Free" : "₹" + ctx.raw}`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "Fee (₹)" },
        },
      },
    },
  });
}

function renderCategoryOverview() {
  const exams = getFilteredExams();
  renderKpis(exams);
  renderCategoryBarChart(exams);
  renderCategoryPie(exams);
  renderExamTable(exams);
}

function bindFilters() {
  document.getElementById("reservationSelect").addEventListener("change", (e) => {
    state.reservation = e.target.value;
    renderCategoryOverview();
  });

  document.querySelectorAll("[data-portal-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-portal-cat]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.portalCategory = btn.dataset.portalCat;
      renderCategoryOverview();
    });
  });

  document.getElementById("womenFreeToggle").addEventListener("click", () => {
    state.womenFreeOnly = !state.womenFreeOnly;
    document.getElementById("womenFreeToggle").classList.toggle("free-active", state.womenFreeOnly);
    renderCategoryOverview();
  });

  let searchTimer;
  document.getElementById("examSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim();
      renderCategoryOverview();
    }, 200);
  });

  document.getElementById("openCompareBtn").addEventListener("click", openCompareDrawer);
  document.getElementById("closeCompareBtn").addEventListener("click", closeCompareDrawer);
  document.querySelector(".compare-backdrop").addEventListener("click", closeCompareDrawer);

  document.getElementById("compareAllBtn").addEventListener("click", () => {
    state.reservation = document.getElementById("reservationSelect").value;
    const exams = getFilteredExams();
    renderKpis(exams);
    renderCategoryBarChart(exams);
    document.getElementById("overviewPanel").scrollIntoView({ behavior: "smooth" });
  });

  document.getElementById("timelineExamSelect").addEventListener("change", (e) => {
    state.timelineExamId = e.target.value;
    renderTimelineChart();
  });
}

function populateReservationSelect() {
  const sel = document.getElementById("reservationSelect");
  sel.innerHTML = feeData.reservationCategories
    .map((c) => `<option value="${c.id}">${c.label}</option>`)
    .join("");
  sel.value = state.reservation;
}

function showDisclaimer() {
  const el = document.getElementById("disclaimerBar");
  if (feeData.meta?.disclaimer) el.textContent = feeData.meta.disclaimer;
  const updated = document.getElementById("lastUpdated");
  if (updated && feeData.meta?.lastUpdated) {
    updated.textContent = "Updated " + new Date(feeData.meta.lastUpdated).toLocaleDateString("en-IN");
  }
}

async function initExamFeesPage() {
  try {
    await loadFeeData();
    populateReservationSelect();
    showDisclaimer();
    renderTimelineOptions();
    bindFilters();
    renderCategoryOverview();
    renderTimelineChart();
    updateCompareButton();
  } catch (err) {
    document.getElementById("mainContent").innerHTML =
      `<div class="bento-card empty-state">Failed to load fee data: ${err.message}</div>`;
  }
}

if (typeof window !== "undefined") {
  window.initExamFeesPage = initExamFeesPage;
}
