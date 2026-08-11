// ---- Configuração do Supabase ----
// A chave "publishable" abaixo é segura para ficar no código do app (front-end).
// O acesso aos dados é controlado pelas políticas de RLS no banco, não por essa chave.
const SUPABASE_URL = "https://fizosmjiwegepbizkjea.supabase.co";
const SUPABASE_KEY = "sb_publishable_hlqusop1DoU6wN2bexJUCw_7cFEaTCD";
const TABLE = "agendamentos";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Constantes de domínio ----
const TYPES = {
  instalacao: { label: "Instalação", color: "#2F5D58", bg: "#E3EFED", dot: "#2F5D58" },
  medicao: { label: "Medição", color: "#95661E", bg: "#F6ECD9", dot: "#B8863E" },
  ambientacao: { label: "Ambientação", color: "#8C3E52", bg: "#F5E4E9", dot: "#A8586B" },
};
const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const HOUR_HEIGHT = 52;
const DEFAULT_START = 7 * 60;
const DEFAULT_END = 20 * 60;

// ---- Estado ----
let appointments = [];
let view = "week";
let currentDate = new Date();
let activeTypes = new Set(Object.keys(TYPES));
let search = "";
let editingId = null;
let confirmDeleteId = null;

// ---- Utilitários de data ----
function dateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function startOfWeek(d) { const r = new Date(d); r.setDate(r.getDate()-r.getDay()); r.setHours(0,0,0,0); return r; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate()+n); return r; }
function isSameDay(a,b) { return dateKey(a)===dateKey(b); }
function monthMatrix(d) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const weeks = [];
  let cursor = new Date(gridStart);
  for (let w=0; w<6; w++) {
    const row = [];
    for (let i=0;i<7;i++) { row.push(new Date(cursor)); cursor = addDays(cursor,1); }
    weeks.push(row);
  }
  return weeks;
}
function toMinutes(t) { const [h,m] = t.split(":").map(Number); return h*60+(m||0); }
function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function layoutItems(items) {
  const sorted = [...items].sort((a,b) => toMinutes(a.time) - toMinutes(b.time));
  const groups = [];
  let currentGroup = [], currentEnd = -Infinity;
  for (const it of sorted) {
    const start = toMinutes(it.time);
    if (currentGroup.length && start >= currentEnd) { groups.push(currentGroup); currentGroup = []; currentEnd = -Infinity; }
    currentGroup.push(it);
    currentEnd = Math.max(currentEnd, start+60);
  }
  if (currentGroup.length) groups.push(currentGroup);
  const result = [];
  for (const group of groups) {
    const colEnds = [];
    for (const it of group) {
      const start = toMinutes(it.time);
      let col = colEnds.findIndex((e) => e <= start);
      if (col === -1) { col = colEnds.length; colEnds.push(start+60); } else colEnds[col] = start+60;
      result.push({ ...it, col, maxCols: 0 });
    }
    const maxCols = colEnds.length;
    for (let i=result.length-group.length; i<result.length; i++) result[i].maxCols = maxCols;
  }
  return result;
}
function getRange(itemsFlat) {
  let start = DEFAULT_START, end = DEFAULT_END;
  for (const it of itemsFlat) {
    const s = toMinutes(it.time), e = s+60;
    if (s < start) start = Math.floor(s/60)*60;
    if (e > end) end = Math.ceil(e/60)*60;
  }
  return { start, end };
}

// ---- Dados: carregar e sincronizar ----
async function loadData() {
  setSyncStatus("loading");
  const { data, error } = await sb.from(TABLE).select("*").order("data").order("hora");
  if (error) { setSyncStatus("error"); console.error(error); return; }
  appointments = data.map(rowToAppt);
  setSyncStatus("ok");
  renderAll();
}
function rowToAppt(row) {
  return {
    id: row.id,
    clientName: row.cliente_nome,
    phone: row.telefone || "",
    address: row.endereco || "",
    type: row.tipo,
    date: row.data,
    time: (row.hora || "00:00:00").slice(0,5),
    notes: row.observacoes || "",
  };
}
function apptToRow(a) {
  return {
    cliente_nome: a.clientName,
    telefone: a.phone || null,
    endereco: a.address || null,
    tipo: a.type,
    data: a.date,
    hora: a.time,
    observacoes: a.notes || null,
  };
}
function setSyncStatus(status) {
  const dot = document.getElementById("syncDot");
  const text = document.getElementById("syncText");
  if (status === "ok") { dot.classList.remove("off"); text.textContent = "conectado"; }
  else if (status === "loading") { dot.classList.remove("off"); text.textContent = "sincronizando…"; }
  else { dot.classList.add("off"); text.textContent = "sem conexão"; }
}

async function saveAppointment(form) {
  const row = apptToRow(form);
  if (editingId) {
    const { error } = await sb.from(TABLE).update(row).eq("id", editingId);
    if (error) { alert("Não foi possível salvar. Tente novamente."); console.error(error); return false; }
  } else {
    const { error } = await sb.from(TABLE).insert(row);
    if (error) { alert("Não foi possível salvar. Tente novamente."); console.error(error); return false; }
  }
  return true;
}
async function deleteAppointment(id) {
  const { error } = await sb.from(TABLE).delete().eq("id", id);
  if (error) { alert("Não foi possível excluir. Tente novamente."); console.error(error); return false; }
  return true;
}

// Sincronização em tempo real: qualquer pessoa da equipe que mudar algo
// aparece na hora nos outros aparelhos, sem precisar atualizar a página.
sb.channel("agendamentos-realtime")
  .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, () => loadData())
  .subscribe((status) => { if (status === "CHANNEL_ERROR") setSyncStatus("error"); });

// ---- Filtragem ----
function getFiltered() {
  const q = search.trim().toLowerCase();
  return appointments.filter((a) => {
    if (!activeTypes.has(a.type)) return false;
    if (q && !(a.clientName.toLowerCase().includes(q) || (a.address||"").toLowerCase().includes(q) || (a.phone||"").toLowerCase().includes(q))) return false;
    return true;
  });
}
function getByDate() {
  const map = {};
  for (const a of getFiltered()) { (map[a.date] ||= []).push(a); }
  for (const k in map) map[k].sort((x,y) => x.time.localeCompare(y.time));
  return map;
}

// ---- Render ----
function renderAll() {
  renderNavLabel();
  renderMainView();
}
function renderNavLabel() {
  const el = document.getElementById("navLabel");
  const weekDates = getWeekDates();
  if (view === "day") el.textContent = `${currentDate.getDate()} de ${MONTHS[currentDate.getMonth()]}, ${currentDate.getFullYear()}`;
  else if (view === "week") {
    const s = weekDates[0], e = weekDates[6];
    el.textContent = s.getMonth()===e.getMonth() ? `${s.getDate()} – ${e.getDate()} de ${MONTHS[s.getMonth()]}` : `${s.getDate()} ${MONTHS[s.getMonth()].slice(0,3)} – ${e.getDate()} ${MONTHS[e.getMonth()].slice(0,3)}`;
  } else el.textContent = `${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
}
function getWeekDates() {
  const start = startOfWeek(currentDate);
  return Array.from({length:7}, (_,i) => addDays(start,i));
}

function apptRowHTML(a) {
  const meta = TYPES[a.type];
  return `
    <div class="appt-row" style="border-left:3px solid ${meta.color}" data-id="${a.id}">
      <div class="appt-time">${a.time}</div>
      <div class="appt-main">
        <div class="appt-top">
          <span class="appt-name">${esc(a.clientName)}</span>
          <span class="appt-chip" style="background:${meta.bg};color:${meta.color}">${meta.label}</span>
        </div>
        ${(a.phone || a.address) ? `<div class="appt-sub">${a.phone ? `<span>📞 ${esc(a.phone)}</span>` : ""}${a.address ? `<span>📍 ${esc(a.address)}</span>` : ""}</div>` : ""}
        ${a.notes ? `<div class="appt-notes">${esc(a.notes)}</div>` : ""}
      </div>
      <div class="appt-actions">
        <button class="icon-btn" data-action="ics" data-id="${a.id}" title="Adicionar lembrete">🔔</button>
        <button class="icon-btn" data-action="edit" data-id="${a.id}" title="Editar">✎</button>
        <button class="icon-btn danger" data-action="delete" data-id="${a.id}" title="Excluir">🗑</button>
      </div>
    </div>`;
}
function dayListHTML(date) {
  const items = (getByDate()[dateKey(date)]) || [];
  if (items.length === 0) return `<div class="empty-day">Nenhum agendamento nesse dia.</div>`;
  return `<div class="appt-list">${items.map(apptRowHTML).join("")}</div>`;
}

function timelineColumnHTML(date, start, end) {
  const items = (getByDate()[dateKey(date)]) || [];
  const laidOut = layoutItems(items);
  const hours = [];
  for (let h = start/60; h <= end/60; h++) hours.push(h);
  const hourlines = hours.slice(0,-1).map((h) =>
    `<div class="tl-hourline" style="top:${(h*60-start)/60*HOUR_HEIGHT}px;height:${HOUR_HEIGHT}px"></div>`
  ).join("");
  const blocks = laidOut.map((a) => {
    const s = toMinutes(a.time);
    const top = ((s-start)/60)*HOUR_HEIGHT + 1;
    const height = HOUR_HEIGHT - 3;
    const meta = TYPES[a.type];
    const left = `calc(${(a.col/a.maxCols)*100}% + 2px)`;
    const width = `calc(${100/a.maxCols}% - 4px)`;
    return `<div style="position:absolute;top:${top}px;height:${height}px;left:0;right:0;">
      <div class="event-block" data-action="edit" data-id="${a.id}" style="left:${left};width:${width};background:${meta.bg};border-left:3px solid ${meta.color};color:${meta.color}">
        <span class="event-time">${a.time}</span>
        <span class="event-name">${esc(a.clientName)}</span>
      </div>
    </div>`;
  }).join("");
  const empty = items.length === 0 ? `<div class="tl-empty">Sem agendamentos</div>` : "";
  return `<div class="tl-col" style="height:${((end-start)/60)*HOUR_HEIGHT}px">${hourlines}${blocks}${empty}</div>`;
}
function hourGutterHTML(start, end) {
  const hours = [];
  for (let h = start/60; h <= end/60; h++) hours.push(h);
  return `<div class="tl-gutter" style="height:${((end-start)/60)*HOUR_HEIGHT}px">
    ${hours.map((h) => `<div class="tl-gutter-label" style="top:${(h*60-start)/60*HOUR_HEIGHT}px">${String(h).padStart(2,"0")}:00</div>`).join("")}
  </div>`;
}

function renderMainView() {
  const root = document.getElementById("mainView");
  const byDate = getByDate();

  if (view === "day") {
    const items = byDate[dateKey(currentDate)] || [];
    const { start, end } = getRange(items);
    root.innerHTML = `
      <div class="day-header">
        <span class="dh-name">${WEEKDAYS[currentDate.getDay()]}</span>
        <span class="dh-num">${currentDate.getDate()} de ${MONTHS[currentDate.getMonth()]}</span>
      </div>
      <div class="timeline-wrap">
        ${hourGutterHTML(start,end)}
        <div class="tl-body">${timelineColumnHTML(currentDate, start, end)}</div>
      </div>`;
  } else if (view === "week") {
    const weekDates = getWeekDates();
    const flat = weekDates.flatMap((d) => byDate[dateKey(d)] || []);
    const { start, end } = getRange(flat);
    const today = new Date();
    root.innerHTML = `
      <div class="week-headers">
        <div class="week-header-gutter"></div>
        ${weekDates.map((d) => `
          <div class="week-header-day ${isSameDay(d,today)?"is-today":""}">
            <div class="wd-name">${WEEKDAYS[d.getDay()]}</div>
            <div class="wd-num">${d.getDate()}</div>
          </div>`).join("")}
      </div>
      <div class="timeline-wrap">
        ${hourGutterHTML(start,end)}
        <div class="tl-body">${weekDates.map((d) => timelineColumnHTML(d,start,end)).join("")}</div>
      </div>`;
  } else {
    const weeksM = monthMatrix(currentDate);
    const today = new Date();
    const cells = weeksM.flat().map((d) => {
      const key = dateKey(d);
      const items = byDate[key] || [];
      const out = d.getMonth() !== currentDate.getMonth();
      const isToday = isSameDay(d, today);
      const isSelected = isSameDay(d, currentDate) && !isToday;
      const shown = items.slice(0,3);
      const extra = items.length - shown.length;
      return `<div class="month-cell ${out?"out":""} ${isToday?"today":""} ${isSelected?"selected":""}" data-action="pick-day" data-date="${key}">
        <span class="month-num">${d.getDate()}</span>
        ${shown.map((a) => { const meta = TYPES[a.type]; return `<div class="month-event" style="background:${meta.bg};color:${meta.color}">${a.time} ${esc(a.clientName)}</div>`; }).join("")}
        ${extra>0 ? `<div class="month-more">+${extra} mais</div>` : ""}
      </div>`;
    }).join("");
    root.innerHTML = `
      <div class="month-grid">
        ${WEEKDAYS.map((w) => `<div class="month-head">${w}</div>`).join("")}
        ${cells}
      </div>
      <div class="month-day-panel">
        <div class="day-heading">${currentDate.getDate()} de ${MONTHS[currentDate.getMonth()]}</div>
        ${dayListHTML(currentDate)}
      </div>`;
  }
  bindDynamicEvents();
}

function bindDynamicEvents() {
  document.querySelectorAll('[data-action="edit"]').forEach((el) =>
    el.addEventListener("click", () => openEditModal(el.dataset.id)));
  document.querySelectorAll('[data-action="delete"]').forEach((el) =>
    el.addEventListener("click", (e) => { e.stopPropagation(); openConfirmDelete(el.dataset.id); }));
  document.querySelectorAll('[data-action="ics"]').forEach((el) =>
    el.addEventListener("click", (e) => { e.stopPropagation(); const a = appointments.find((x) => x.id===el.dataset.id); if (a) exportOneICS(a); }));
  document.querySelectorAll('[data-action="pick-day"]').forEach((el) =>
    el.addEventListener("click", () => { currentDate = new Date(el.dataset.date + "T00:00:00"); renderAll(); }));
}

// ---- Navegação ----
function goPrev() {
  if (view === "day") currentDate = addDays(currentDate,-1);
  else if (view === "week") currentDate = addDays(currentDate,-7);
  else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth()-1, 1);
  renderAll();
}
function goNext() {
  if (view === "day") currentDate = addDays(currentDate,1);
  else if (view === "week") currentDate = addDays(currentDate,7);
  else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth()+1, 1);
  renderAll();
}
function goToday() { currentDate = new Date(); renderAll(); }

// ---- Modal: adicionar/editar ----
const emptyForm = () => ({ clientName:"", phone:"", address:"", type:"instalacao", date: dateKey(currentDate), time:"09:00", notes:"" });
let formState = emptyForm();

function openNewModal() { editingId = null; formState = emptyForm(); renderModal(); }
function openEditModal(id) {
  const a = appointments.find((x) => x.id === id);
  if (!a) return;
  editingId = id;
  formState = { ...a };
  renderModal();
}
function closeModal() { document.getElementById("modalRoot").innerHTML = ""; }

function renderModal() {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal">
        <div class="modal-head">
          <h3>${editingId ? "Editar agendamento" : "Novo agendamento"}</h3>
          <button class="modal-close" id="modalCloseBtn">✕</button>
        </div>
        <form id="apptForm">
          <div class="field">
            <label>Cliente</label>
            <input required id="f_clientName" value="${esc(formState.clientName)}" placeholder="Nome do cliente" />
          </div>
          <div class="row2">
            <div class="field"><label>Telefone</label><input id="f_phone" value="${esc(formState.phone)}" placeholder="(00) 00000-0000" /></div>
            <div class="field"><label>Endereço</label><input id="f_address" value="${esc(formState.address)}" placeholder="Rua, bairro" /></div>
          </div>
          <div class="field">
            <label>Tipo de atendimento</label>
            <div class="type-picker" id="typePicker">
              ${Object.entries(TYPES).map(([k,meta]) => `<div class="type-pill ${formState.type===k?"selected":""}" data-type="${k}" style="${formState.type===k?`background:${meta.color}`:""}">${meta.label}</div>`).join("")}
            </div>
          </div>
          <div class="row2">
            <div class="field"><label>Data</label><input required type="date" id="f_date" value="${formState.date}" /></div>
            <div class="field"><label>Horário</label><input required type="time" id="f_time" value="${formState.time}" /></div>
          </div>
          <div class="field">
            <label>Observações</label>
            <textarea id="f_notes" placeholder="Detalhes do pedido, medidas, preferências...">${esc(formState.notes)}</textarea>
          </div>
          <button type="button" class="btn-secondary btn-full" id="icsFromModalBtn">🔔 Adicionar lembrete no celular (1h antes)</button>
          <div class="modal-actions">
            ${editingId ? `<button type="button" class="btn-text-danger" id="deleteFromModalBtn">Excluir</button>` : ""}
            <button type="button" class="btn-secondary" id="cancelBtn">Cancelar</button>
            <button type="submit" class="btn-primary">${editingId ? "Salvar" : "Adicionar"}</button>
          </div>
        </form>
      </div>
    </div>`;

  document.getElementById("modalOverlay").addEventListener("click", (e) => { if (e.target.id === "modalOverlay") closeModal(); });
  document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
  document.getElementById("cancelBtn").addEventListener("click", closeModal);
  document.querySelectorAll("#typePicker .type-pill").forEach((el) =>
    el.addEventListener("click", () => { formState.type = el.dataset.type; renderModal(); syncFormFieldsFromInputs(); }));
  if (editingId) document.getElementById("deleteFromModalBtn").addEventListener("click", () => { closeModal(); openConfirmDelete(editingId); });
  document.getElementById("icsFromModalBtn").addEventListener("click", () => {
    readFormIntoState();
    if (!formState.clientName.trim() || !formState.date || !formState.time) { alert("Preencha ao menos o cliente, a data e o horário."); return; }
    exportOneICS({ ...formState, id: editingId || "novo" });
  });
  document.getElementById("apptForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    readFormIntoState();
    if (!formState.clientName.trim() || !formState.date || !formState.time) return;
    const ok = await saveAppointment(formState);
    if (ok) { closeModal(); loadData(); }
  });
}
function readFormIntoState() {
  formState.clientName = document.getElementById("f_clientName").value;
  formState.phone = document.getElementById("f_phone").value;
  formState.address = document.getElementById("f_address").value;
  formState.date = document.getElementById("f_date").value;
  formState.time = document.getElementById("f_time").value;
  formState.notes = document.getElementById("f_notes").value;
}
function syncFormFieldsFromInputs() {
  // re-render preserved values already handled via formState before re-render
}

// ---- Confirmação de exclusão ----
function openConfirmDelete(id) {
  confirmDeleteId = id;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay" id="confirmOverlay">
      <div class="modal" style="max-width:320px;">
        <div class="modal-head"><h3>Excluir agendamento</h3><button class="modal-close" id="confirmCloseBtn">✕</button></div>
        <p style="font-size:13px;color:var(--muted);margin:0;">Essa ação não pode ser desfeita. Deseja continuar?</p>
        <div class="confirm-actions">
          <button class="btn-secondary" id="confirmCancelBtn">Cancelar</button>
          <button class="btn-primary" style="background:#8C3E52" id="confirmDeleteBtn">Excluir</button>
        </div>
      </div>
    </div>`;
  document.getElementById("confirmOverlay").addEventListener("click", (e) => { if (e.target.id === "confirmOverlay") closeModal(); });
  document.getElementById("confirmCloseBtn").addEventListener("click", closeModal);
  document.getElementById("confirmCancelBtn").addEventListener("click", closeModal);
  document.getElementById("confirmDeleteBtn").addEventListener("click", async () => {
    const ok = await deleteAppointment(confirmDeleteId);
    if (ok) { closeModal(); loadData(); }
  });
}

// ---- Exportar lembrete (.ics) ----
function pad2(n) { return String(n).padStart(2,"0"); }
function icsDate(dateStr, timeStr) {
  const [y,m,d] = dateStr.split("-").map(Number);
  const [hh,mm] = timeStr.split(":").map(Number);
  return `${y}${pad2(m)}${pad2(d)}T${pad2(hh)}${pad2(mm)}00`;
}
function icsDateEnd(dateStr, timeStr) {
  const [y,m,d] = dateStr.split("-").map(Number);
  const [hh,mm] = timeStr.split(":").map(Number);
  const dt = new Date(y, m-1, d, hh, mm+60);
  return `${dt.getFullYear()}${pad2(dt.getMonth()+1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}00`;
}
function icsEscape(s) { return String(s||"").replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\n/g,"\\n"); }
function apptToICSBlock(a) {
  const meta = TYPES[a.type];
  const desc = [meta.label, a.phone?`Telefone: ${a.phone}`:"", a.notes||""].filter(Boolean).join(" | ");
  return ["BEGIN:VEVENT",
    `UID:${a.id}-${Date.now()}@agenda-cortinas`,
    `DTSTAMP:${icsDate(a.date,a.time)}`,
    `DTSTART:${icsDate(a.date,a.time)}`,
    `DTEND:${icsDateEnd(a.date,a.time)}`,
    `SUMMARY:${icsEscape(`${meta.label} - ${a.clientName}`)}`,
    a.address ? `LOCATION:${icsEscape(a.address)}` : "",
    `DESCRIPTION:${icsEscape(desc)}`,
    "BEGIN:VALARM","TRIGGER:-PT1H","ACTION:DISPLAY","DESCRIPTION:Lembrete de agendamento","END:VALARM",
    "END:VEVENT"].filter(Boolean).join("\r\n");
}
function downloadICS(filename, blocks) {
  const content = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Agenda Cortinas e Persianas//PT-BR","CALSCALE:GREGORIAN",...blocks,"END:VCALENDAR"].join("\r\n");
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
function exportOneICS(a) { downloadICS(`${a.clientName.replace(/[^a-zA-Z0-9]+/g,"-")}.ics`, [apptToICSBlock(a)]); }
function exportAllICS() { downloadICS("agenda-cortinas.ics", getFiltered().map(apptToICSBlock)); }

// ---- Ligações da interface estática ----
document.querySelectorAll(".view-tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    view = btn.dataset.view;
    document.querySelectorAll(".view-tabs button").forEach((b) => b.classList.toggle("active", b===btn));
    renderAll();
  });
});
document.querySelector('.view-tabs button[data-view="week"]').classList.add("active");
document.getElementById("navPrev").addEventListener("click", goPrev);
document.getElementById("navNext").addEventListener("click", goNext);
document.getElementById("navToday").addEventListener("click", goToday);
document.getElementById("addBtn").addEventListener("click", openNewModal);
document.getElementById("exportAllBtn").addEventListener("click", exportAllICS);
document.getElementById("searchInput").addEventListener("input", (e) => { search = e.target.value; renderMainView(); });
document.querySelectorAll(".type-toggle").forEach((el) => {
  el.addEventListener("click", () => {
    const t = el.dataset.type;
    if (activeTypes.has(t)) activeTypes.delete(t); else activeTypes.add(t);
    el.classList.toggle("on");
    renderMainView();
  });
});

// ---- Instalação do app (Android/Chrome) ----
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!localStorage.getItem("installBannerDismissed")) {
    document.getElementById("installBanner").classList.add("show");
  }
});
document.getElementById("installBtn").addEventListener("click", async () => {
  if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; }
  document.getElementById("installBanner").classList.remove("show");
});
document.getElementById("installClose").addEventListener("click", () => {
  document.getElementById("installBanner").classList.remove("show");
  localStorage.setItem("installBannerDismissed", "1");
});
// iOS Safari não dispara beforeinstallprompt — mostramos instrução manual.
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
if (isIOS && !isStandalone && !localStorage.getItem("installBannerDismissed")) {
  document.getElementById("installText").textContent = "Toque em Compartilhar e depois em \"Adicionar à Tela de Início\" para instalar o app.";
  document.getElementById("installBtn").style.display = "none";
  document.getElementById("installBanner").classList.add("show");
}

// ---- Service worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ---- Início ----
loadData();
