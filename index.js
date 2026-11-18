import { generateRaw, getRequestHeaders, user_avatar } from '/script.js';
import { getContext } from '/scripts/extensions.js';

import { apiBase, generateCustom, generateNovel, listModels, novelModels, toBase64 } from './providers.js';

const libraryFile = 'kacha-library-v1.json';
const profilesFile = 'kacha-api-profiles-v1.json';
const defaultNovelModel = 'nai-diffusion-3';
const historyKey = 'kacha:images:v1';
const validImage = value => typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
const newId = () => globalThis.crypto.randomUUID?.() ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const dialog = document.createElement('dialog');
dialog.className = 'kacha';
dialog.setAttribute('aria-label', '咔嚓');
dialog.innerHTML = `
    <header class="kacha-row">
        <strong>咔嚓</strong>
        <nav aria-label="咔嚓">
            <button type="button" data-tab="generate">生图</button>
            <button type="button" data-tab="presets">预设</button>
            <button type="button" data-tab="looks">样貌</button>
            <button type="button" data-tab="history">记录</button>
            <button type="button" data-tab="settings">设置</button>
        </nav>
        <button type="button" data-close aria-label="关闭"><i class="fa-solid fa-xmark"></i></button>
    </header>
    <main>
        <section data-view="generate">
            <div class="kacha-row">
                <select id="kacha-service" aria-label="API 组合"></select>
                <select id="kacha-preset" aria-label="预设"></select>
            </div>
            <textarea id="kacha-prompt" placeholder="提示词" aria-label="提示词"></textarea>
            <div data-images="draft"></div>
            <div class="kacha-row kacha-toggles">
                <label><input type="checkbox" id="kacha-floor">参考本楼层</label>
                <label><input type="checkbox" id="kacha-char">Char</label>
                <label><input type="checkbox" id="kacha-user">User</label>
                <button type="button" id="kacha-generate">生成</button>
            </div>
            <div id="kacha-result"></div>
        </section>
        <section data-view="presets" hidden>
            <div class="kacha-row">
                <select id="kacha-edit-preset" aria-label="编辑预设"></select>
                <button type="button" id="kacha-import">导入</button>
                <input type="file" id="kacha-import-file" accept=".json,application/json" hidden>
            </div>
            <input id="kacha-preset-name" placeholder="预设名称" aria-label="预设名称" maxlength="80">
            <textarea id="kacha-preset-prompt" placeholder="提示词" aria-label="预设提示词"></textarea>
            <div data-images="preset"></div>
            <div class="kacha-row">
                <button type="button" id="kacha-save-preset">保存</button>
                <button type="button" id="kacha-export">导出</button>
                <button type="button" id="kacha-delete-preset">删除</button>
            </div>
        </section>
        <section data-view="looks" hidden>
            <select id="kacha-look-type" aria-label="样貌对象"><option value="char">Char</option><option value="user">User</option></select>
            <div id="kacha-look-name"></div>
            <textarea id="kacha-look-prompt" placeholder="样貌描述" aria-label="样貌描述"></textarea>
            <div data-images="look"></div>
            <button type="button" id="kacha-save-look">保存</button>
        </section>
        <section data-view="history" hidden><div id="kacha-history"></div></section>
        <section data-view="settings" hidden>
            <div class="kacha-row">
                <select id="kacha-edit-profile" aria-label="编辑 API 组合"></select>
                <button type="button" id="kacha-delete-profile">删除</button>
            </div>
            <input id="kacha-profile-name" placeholder="API 组合名称" aria-label="API 组合名称" maxlength="80">
            <select id="kacha-settings-service" aria-label="配置服务"><option value="custom">自定义</option><option value="novel">NovelAI</option></select>
            <div id="kacha-custom">
                <label>API URL<input id="kacha-url" type="url" placeholder="https://example.com/v1" required></label>
                <label>API Key<input id="kacha-key" type="password" autocomplete="off"></label>
                <div class="kacha-row"><button type="button" id="kacha-connect">连接</button><select id="kacha-model" aria-label="模型" disabled></select></div>
            </div>
            <div id="kacha-novel" hidden>
                <label>NovelAI Key<input id="kacha-novel-key" type="password" autocomplete="off"></label>
                <div class="kacha-row">
                    <select id="kacha-novel-model" aria-label="NovelAI 模型"></select>
                </div>
            </div>
            <button type="button" id="kacha-save-profile">保存</button>
        </section>
    </main>
    <footer id="kacha-status" role="status"></footer>`;
const $ = selector => dialog.querySelector(selector);
const images = { draft: [], preset: [], look: [] };
let library = { presets: [], looks: {} };
let libraryReady = false;
let profiles = { entries: [], active: null };
let profilesReady = false;
let profileWrite;
let target = {};
let activeTab;
let connected;
let generationId = 0;

async function readAccountFile(file) {
    const response = await fetch('/user/files/' + file, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('无法读取酒馆账号数据');
    return response.json();
}

async function writeAccountFile(file, value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.length > 40 * 1024 * 1024) throw new Error('酒馆文件空间不足');
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: file, data: toBase64(bytes) }),
    });
    if (!response.ok) throw new Error('无法保存酒馆账号数据');
}

async function loadProfiles() {
    const stored = await readAccountFile(profilesFile);
    if (stored) {
        if (!Array.isArray(stored.entries)) throw new Error('API 组合文件格式有误');
        return stored;
    }
    return { entries: [], active: null };
}

async function saveProfiles(next) {
    if (!profilesReady) throw new Error('API 组合尚未加载，请重新打开面板');
    if (profileWrite) throw new Error('API 组合正在保存');
    profileWrite = writeAccountFile(profilesFile, next);
    try {
        await profileWrite;
        profiles = next;
    } finally {
        profileWrite = undefined;
    }
}

async function loadLibrary() {
    const data = await readAccountFile(libraryFile);
    if (!data) return { presets: [], looks: {} };
    if (!Array.isArray(data.presets) || !data.looks || typeof data.looks !== 'object') throw new Error('酒馆预设库格式有误');
    return data;
}

function status(message = '') {
    $('#kacha-status').textContent = message;
}

function tab(name) {
    activeTab = name;
    for (const section of dialog.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== name;
    for (const button of dialog.querySelectorAll('[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === name));
    status();
    if (name === 'history') showHistory();
}

function withAction(element, eventName, action) {
    element.addEventListener(eventName, async event => {
        if (eventName === 'submit') event.preventDefault();
        if (element.dataset.busy) return;
        element.dataset.busy = 'true';
        if (element instanceof HTMLButtonElement) element.disabled = true;
        status();
        try {
            await action(event);
        } catch (error) {
            status(error.message);
        } finally {
            delete element.dataset.busy;
            if (element instanceof HTMLButtonElement) element.disabled = false;
        }
    });
}

function setOptions(select, choices, placeholder, selected) {
    select.replaceChildren(new Option(placeholder, ''), ...choices.map(({ id, name }) => new Option(name, id)));
    select.value = selected || '';
    if (select.selectedIndex < 0) select.selectedIndex = 0;
}

function renderPresets(selected = '') {
    const preset = $('#kacha-preset');
    setOptions(preset, library.presets, '预设', preset.value);
    const editor = $('#kacha-edit-preset');
    setOptions(editor, library.presets, '新建预设', selected);
    editPreset();
}

function editPreset() {
    const preset = library.presets.find(item => item.id === $('#kacha-edit-preset').value);
    $('#kacha-preset-name').value = preset?.name || '';
    $('#kacha-preset-prompt').value = preset?.prompt || '';
    images.preset = [...(preset?.images || [])];
    $('#kacha-export').disabled = $('#kacha-delete-preset').disabled = !preset;
    renderImages('preset');
}

function lookKey(type) {
    const id = target[type]?.id;
    return id ? type + ':' + id : null;
}

function renderLook() {
    const type = $('#kacha-look-type').value;
    const key = lookKey(type);
    const look = library.looks[key];
    $('#kacha-look-name').textContent = target[type]?.name || '当前没有可用对象';
    $('#kacha-look-prompt').value = look?.prompt || '';
    $('#kacha-save-look').disabled = !key;
    images.look = [...(look?.images || [])];
    renderImages('look');
}

const viewer = document.createElement('dialog');
viewer.className = 'kacha kacha-viewer';
viewer.setAttribute('aria-label', '图片预览');
const zoomed = document.createElement('img');
zoomed.alt = '图片预览';
viewer.append(zoomed);
viewer.addEventListener('click', () => viewer.close());
viewer.addEventListener('close', () => zoomed.removeAttribute('src'));
function preview(src) {
    zoomed.src = src;
    viewer.showModal();
}

function thumbnail(src, onDelete) {
    const wrap = document.createElement('div');
    wrap.className = 'kacha-thumb';
    const button = document.createElement('button');
    button.type = 'button';
    button.title = '查看图片';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '查看图片';
    button.append(img);
    button.addEventListener('click', () => preview(src));
    wrap.append(button);
    if (onDelete) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'kacha-remove';
        remove.setAttribute('aria-label', '移除图片');
        remove.textContent = '×';
        remove.addEventListener('click', onDelete);
        wrap.append(remove);
    }
    return wrap;
}

async function addImages(kind, files) {
    if (images[kind].length + files.length > 8) throw new Error('最多添加 8 张参考图');
    const added = await Promise.all(files.map(file => new Promise((resolve, reject) => {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
            reject(new Error('请选择 8 MB 以内的 PNG、JPEG 或 WebP 图片'));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
    })));
    if (images[kind].length + added.length > 8) throw new Error('最多添加 8 张参考图');
    images[kind].push(...added);
    renderImages(kind);
}

function renderImages(kind) {
    const wrap = $('[data-images="' + kind + '"]');
    wrap.className = 'kacha-images';
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '＋ 参考图';
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/png,image/jpeg,image/webp';
    input.hidden = true;
    add.addEventListener('click', () => input.click());
    withAction(input, 'change', () => addImages(kind, [...input.files]));
    wrap.replaceChildren(...images[kind].map((src, index) => thumbnail(src, () => {
        images[kind].splice(index, 1);
        renderImages(kind);
    })), add, input);
}

function history() {
    try {
        const records = JSON.parse(localStorage.getItem(historyKey) || '[]');
        return Array.isArray(records) ? records.filter(record => validImage(record?.image)) : [];
    } catch {
        return [];
    }
}

function saveImage(record) {
    const records = [record, ...history()];
    while (records.length) {
        try {
            localStorage.setItem(historyKey, JSON.stringify(records));
            return true;
        } catch (error) {
            if (error.name !== 'QuotaExceededError') return false;
            records.pop();
        }
    }
    return false;
}

function showHistory() {
    const wrap = $('#kacha-history');
    const records = history();
    wrap.replaceChildren(...records.map(record => thumbnail(record.image, () => {
        try {
            localStorage.setItem(historyKey, JSON.stringify(history().filter(item => item.id !== record.id)));
            showHistory();
        } catch {
            status('无法更新浏览器记录');
        }
    })));
    if (!records.length) wrap.textContent = '暂无图片';
}

async function saveLibrary(next) {
    if (!libraryReady) throw new Error('预设库尚未加载，请重新打开面板');
    await writeAccountFile(libraryFile, next);
    library = next;
}

function renderProfiles(editorId = profiles.active) {
    const select = $('#kacha-service');
    select.replaceChildren();
    if (!profiles.entries.length) select.add(new Option('配置 API', ''));
    for (const entry of profiles.entries) select.add(new Option(entry.name, entry.id));
    select.value = profiles.active || '';
    if (select.selectedIndex < 0) select.selectedIndex = 0;
    setOptions($('#kacha-edit-profile'), profiles.entries, '新建 API 组合', editorId);
    editProfile();
}

function editProfile() {
    const profile = profiles.entries.find(item => item.id === $('#kacha-edit-profile').value);
    connected = undefined;
    $('#kacha-profile-name').value = profile?.name || '';
    $('#kacha-delete-profile').disabled = !profile;
    $('#kacha-settings-service').value = profile?.service || 'custom';
    $('#kacha-url').value = profile?.url || '';
    $('#kacha-key').value = $('#kacha-novel-key').value = '';
    $('#kacha-key').placeholder = profile?.service === 'custom' && profile.key ? '已保存' : '';
    $('#kacha-novel-key').placeholder = profile?.service === 'novel' && profile.key ? '已保存' : '';
    const choices = profile?.service === 'custom' && profile.model ? [{ id: profile.model, name: profile.model }] : [];
    setOptions($('#kacha-model'), choices, '选择模型', profile?.model);
    $('#kacha-model').disabled = true;
    const novelSelect = $('#kacha-novel-model');
    novelSelect.replaceChildren(...novelModels.map(([id, name]) => new Option(name, id)));
    novelSelect.value = profile?.model || defaultNovelModel;
    if (!novelSelect.value) novelSelect.value = defaultNovelModel;
    showServiceFields();
}

function showServiceFields() {
    const service = $('#kacha-settings-service').value;
    $('#kacha-custom').hidden = service !== 'custom';
    $('#kacha-novel').hidden = service !== 'novel';
}

function getTarget(messageIndex) {
    const context = getContext();
    const message = context.chat[messageIndex];
    const character = !message?.is_user && message?.original_avatar
        ? context.characters.find(item => item.avatar === message.original_avatar)
        : context.characters[context.characterId];
    return {
        text: message?.mes || '',
        char: { id: character?.avatar, name: character?.name },
        user: { id: user_avatar, name: context.name1 },
    };
}

async function open(messageIndex) {
    target = getTarget(messageIndex);
    generationId++;
    libraryReady = false;
    library = { presets: [], looks: {} };
    renderPresets();
    images.draft = [];
    $('#kacha-prompt').value = '';
    $('#kacha-preset').value = '';
    $('#kacha-result').replaceChildren();
    for (const type of ['floor', 'char', 'user']) $('#kacha-' + type).checked = false;
    $('#kacha-floor').disabled = !target.text;
    for (const type of ['char', 'user']) $('#kacha-' + type).disabled = true;
    renderImages('draft');
    renderLook();
    tab('generate');
    profiles = { entries: [], active: null };
    profilesReady = false;
    renderProfiles();
    dialog.showModal();
    const currentOpen = generationId;
    const isCurrent = () => currentOpen === generationId && dialog.open;
    await Promise.all([
        loadProfiles().then(next => {
            if (!isCurrent()) return;
            profiles = next;
            profilesReady = true;
            renderProfiles();
        }).catch(error => { if (isCurrent()) status(error.message); }),
        loadLibrary().then(next => {
            if (!isCurrent()) return;
            library = next;
            libraryReady = true;
            renderPresets();
            renderLook();
            for (const type of ['char', 'user']) $('#kacha-' + type).disabled = !library.looks[lookKey(type)];
        }).catch(error => { if (isCurrent()) status(error.message); }),
    ]);
}

withAction($('#kacha-service'), 'change', async event => {
    const select = event.target;
    try {
        await saveProfiles({ ...profiles, active: select.value });
    } catch (error) {
        select.value = profiles.active || '';
        throw error;
    }
});
$('#kacha-edit-profile').addEventListener('change', editProfile);
$('#kacha-settings-service').addEventListener('change', showServiceFields);
$('#kacha-edit-preset').addEventListener('change', editPreset);
$('#kacha-look-type').addEventListener('change', renderLook);
$('[data-close]').addEventListener('click', () => dialog.close());
for (const button of dialog.querySelectorAll('[data-tab]')) button.addEventListener('click', () => tab(button.dataset.tab));
dialog.addEventListener('paste', event => {
    const kind = { generate: 'draft', presets: 'preset', looks: 'look' }[activeTab];
    const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
    if (!kind || !files.length) return;
    event.preventDefault();
    addImages(kind, files).catch(error => status(error.message));
});

for (const input of [$('#kacha-url'), $('#kacha-key')]) input.addEventListener('input', () => {
    connected = undefined;
    $('#kacha-model').disabled = true;
});

withAction($('#kacha-connect'), 'click', async () => {
    const currentOpen = generationId;
    const editorId = $('#kacha-edit-profile').value;
    const previous = profiles.entries.find(item => item.id === editorId && item.service === 'custom');
    const inputUrl = $('#kacha-url').value.trim();
    const inputKey = $('#kacha-key').value.trim();
    const url = apiBase(inputUrl);
    const key = inputKey || (previous?.url === url ? previous.key : '');
    if (!key) throw new Error('请输入 API Key');
    const models = await listModels(url, key);
    if (currentOpen !== generationId || !dialog.open || editorId !== $('#kacha-edit-profile').value
        || $('#kacha-settings-service').value !== 'custom' || $('#kacha-url').value.trim() !== inputUrl || $('#kacha-key').value.trim() !== inputKey) return;
    connected = { url, key };
    setOptions($('#kacha-model'), models.map(id => ({ id, name: id })), '选择模型',
        previous?.url === url ? previous.model : '');
    $('#kacha-model').disabled = !models.length;
    if (!models.length) status('服务未返回模型');
});

withAction($('#kacha-save-profile'), 'click', async () => {
    const service = $('#kacha-settings-service').value;
    const name = $('#kacha-profile-name').value.trim();
    if (!name) throw new Error('请输入 API 组合名称');
    const id = $('#kacha-edit-profile').value || newId();
    const existing = profiles.entries.find(item => item.id === id);
    const previous = existing?.service === service ? existing : null;
    const profile = { id, name, service };
    if (service === 'custom') {
        const url = apiBase($('#kacha-url').value.trim());
        const fallback = previous?.url === url ? previous.key : '';
        const key = $('#kacha-key').value.trim() || fallback;
        const model = $('#kacha-model').value;
        if (!model || !key || (!connected && (!previous || url !== previous.url || key !== previous.key))) {
            throw new Error('请连接服务并选择模型');
        }
        Object.assign(profile, { url, key, model });
    } else {
        const key = $('#kacha-novel-key').value.trim() || previous?.key;
        if (!key) throw new Error('请输入 NovelAI Key');
        Object.assign(profile, { key, model: $('#kacha-novel-model').value });
    }
    const entries = existing
        ? profiles.entries.map(item => item.id === id ? profile : item)
        : [...profiles.entries, profile];
    await saveProfiles({ entries, active: id });
    renderProfiles(id);
    status('已保存');
});

withAction($('#kacha-delete-profile'), 'click', async () => {
    const id = $('#kacha-edit-profile').value;
    if (!id || !window.confirm('删除这个 API 组合？')) return;
    const entries = profiles.entries.filter(item => item.id !== id);
    await saveProfiles({ entries, active: profiles.active === id ? entries[0]?.id ?? null : profiles.active });
    renderProfiles();
});

withAction($('#kacha-save-preset'), 'click', async () => {
    const name = $('#kacha-preset-name').value.trim();
    const prompt = $('#kacha-preset-prompt').value.trim();
    const id = $('#kacha-edit-preset').value || newId();
    if (!name || (!prompt && !images.preset.length)) throw new Error('请输入名称，并添加提示词或参考图');
    const preset = { id, name, prompt, images: [...images.preset] };
    const presets = library.presets.some(item => item.id === id)
        ? library.presets.map(item => item.id === id ? preset : item)
        : [...library.presets, preset];
    await saveLibrary({ ...library, presets });
    renderPresets(id);
    status('已保存');
});

withAction($('#kacha-delete-preset'), 'click', async () => {
    const id = $('#kacha-edit-preset').value;
    if (!id || !window.confirm('删除这个预设？')) return;
    await saveLibrary({ ...library, presets: library.presets.filter(item => item.id !== id) });
    renderPresets();
});

$('#kacha-import').addEventListener('click', () => $('#kacha-import-file').click());
withAction($('#kacha-import-file'), 'change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) throw new Error('预设文件过大');
    const fileData = JSON.parse(await file.text());
    const item = fileData.preset;
    if (fileData.format !== 'kacha-preset-v1' || typeof item?.name !== 'string' || !item.name.trim()
        || typeof item.prompt !== 'string' || !Array.isArray(item.images) || item.images.length > 8 || !item.images.every(validImage)) {
        throw new Error('预设文件无效');
    }
    const preset = { id: newId(), name: item.name.slice(0, 80), prompt: item.prompt, images: item.images };
    await saveLibrary({ ...library, presets: [...library.presets, preset] });
    renderPresets(preset.id);
    status('已导入');
});

$('#kacha-export').addEventListener('click', () => {
    const item = library.presets.find(preset => preset.id === $('#kacha-edit-preset').value);
    if (!item) return;
    const { name, prompt, images } = item;
    const blob = new Blob([JSON.stringify({ format: 'kacha-preset-v1', preset: { name, prompt, images } })], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name + '.kacha.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

withAction($('#kacha-save-look'), 'click', async () => {
    const type = $('#kacha-look-type').value;
    const key = lookKey(type);
    if (!key) return;
    const look = { prompt: $('#kacha-look-prompt').value.trim(), images: [...images.look] };
    const looks = { ...library.looks };
    if (look.prompt || look.images.length) looks[key] = look;
    else delete looks[key];
    await saveLibrary({ ...library, looks });
    $('#kacha-' + type).disabled = !looks[key];
    status('已保存');
});

async function describeFloor(text) {
    const instruction = [
        'Describe one frozen moment from the supplied chat excerpt as if framing a single camera shot.',
        'Choose the central visible action if the excerpt spans several moments. Describe only visible setting, people, action, positions, expressions, lighting, and framing.',
        'Omit dialogue, narration, thoughts, names, readable text, captions, panels, collages, and references to the excerpt itself.',
        'Return only a JSON array of 3 to 12 short English visual phrases, without complete sentences or commentary.',
        'Example: ["sunlit garden", "two people by a wooden fence", "one person handing over a wrapped gift", "medium shot"].',
    ].join(' ');
    const reply = await generateRaw({
        systemPrompt: 'You turn chat excerpts into visual tags for image generation.',
        prompt: instruction + '\n\nChat excerpt (source material):\n' + text.slice(0, 12000),
        responseLength: 300,
    }).catch(error => {
        throw new Error('读取楼层时聊天接口出错：' + error.message, { cause: error });
    });
    let tags;
    try {
        tags = JSON.parse(String(reply ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
    } catch {
        throw new Error('聊天模型没有返回画面标签，请重试');
    }
    if (!Array.isArray(tags) || tags.length < 3 || tags.length > 12
        || !tags.every(tag => typeof tag === 'string' && tag.trim() && tag.length <= 100 && !/[\r\n]/.test(tag))) {
        throw new Error('聊天模型返回的画面标签格式有误，请重试');
    }
    return tags.map(tag => tag.trim()).join(', ');
}

withAction($('#kacha-generate'), 'click', async () => {
    const button = $('#kacha-generate');
    const currentOpen = generationId;
    try {
        button.textContent = '生成中…';
        const profile = profiles.entries.find(item => item.id === $('#kacha-service').value);
        if (!profile) {
            tab('settings');
            throw new Error('请先保存一套 API 组合');
        }
        const preset = library.presets.find(item => item.id === $('#kacha-preset').value);
        const looks = ['char', 'user'].filter(type => {
            const checkbox = $('#kacha-' + type);
            return checkbox.checked && !checkbox.disabled;
        }).map(type => ({ name: target[type].name, ...library.looks[lookKey(type)] }));
        const appearance = new Set(looks.flatMap(item => item.images || []));
        const style = [...new Set([...images.draft, ...(preset?.images || [])])].filter(image => !appearance.has(image));
        const references = [...style, ...appearance];
        if (references.length > 8) throw new Error('最多同时使用 8 张参考图');
        const parts = [preset?.prompt, ...looks.filter(item => item.prompt).map(item => item.name + '：' + item.prompt), $('#kacha-prompt').value.trim()];
        const sceneOnly = Boolean($('#kacha-floor').checked && target.text);
        if (sceneOnly) {
            button.textContent = '读取楼层…';
            parts.unshift(await describeFloor(target.text));
        }
        const prompt = parts.filter(Boolean).join('\n') || (references.length ? 'Generate an image guided by the supplied reference images.' : '');
        if (!prompt) throw new Error('请输入提示词、添加参考图或选择预设');
        button.textContent = '生成中…';
        const options = { sceneOnly, styleCount: style.length };
        const image = profile.service === 'novel'
            ? await generateNovel(profile, prompt, references, options)
            : await generateCustom(profile, prompt, references, options);
        if (!validImage(image)) throw new Error('服务返回的图片无效');
        const saved = saveImage({ id: newId(), image });
        if (currentOpen === generationId && dialog.open) {
            $('#kacha-result').replaceChildren(thumbnail(image));
            if (!saved) status('浏览器空间不足，本图仅可预览');
            if (activeTab === 'history') showHistory();
        }
    } finally {
        button.textContent = '生成';
    }
});

document.body.append(dialog, viewer);
function decorate(row) {
    const edit = row.querySelector('.mes_edit');
    if (!edit || row.querySelector('.kacha-camera')) return;
    const camera = document.createElement('div');
    camera.className = 'mes_button kacha-camera fa-solid fa-camera';
    camera.tabIndex = 0;
    camera.title = '生图';
    camera.setAttribute('role', 'button');
    camera.setAttribute('aria-label', '生图');
    camera.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) camera.click();
    });
    const hint = row.querySelector('.extraMesButtonsHint');
    if (hint) hint.before(camera);
    else edit.after(camera);
    if (['none', 'normal', '""', "''"].includes(getComputedStyle(camera, '::before').content)) {
        camera.classList.replace('fa-camera', 'fa-image');
    }
}

function attach() {
    const chat = document.querySelector('#chat');
    if (!chat) return;
    for (const row of chat.querySelectorAll('.mes[mesid]')) decorate(row);
    new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node.matches('.mes[mesid]')) decorate(node);
                else if (!node.classList.contains('kacha-camera')) {
                    const row = node.closest('.mes[mesid]');
                    if (row) decorate(row);
                    for (const nested of node.querySelectorAll('.mes[mesid]')) decorate(nested);
                }
            }
        }
    }).observe(chat, { childList: true, subtree: true });
    chat.addEventListener('click', event => {
        const button = event.target.closest('.kacha-camera');
        if (!button || dialog.open) return;
        event.stopPropagation();
        open(Number(button.closest('.mes').getAttribute('mesid'))).catch(error => status(error.message));
    });
}

attach();
