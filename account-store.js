// Each store represents one SillyTavern account file. Keep its operations in
// order within this page, and check the server before and after every write.
export function createAccountStore({ file, empty, validate, headers, encode, fetcher = fetch }) {
    let pending = Promise.resolve();
    let seenFile = false;

    async function read() {
        const url = '/user/files/' + file + '?kacha=' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetcher(url, { cache: 'no-store', signal: controller.signal });
            if (response.status === 404) {
                if (seenFile) throw new Error('之前读取过的数据文件暂时不存在，请检查服务器后重试');
                return empty();
            }
            if (!response.ok) throw new Error('读取酒馆数据失败（' + response.status + '）');
            let value;
            try { value = await response.json(); } catch (error) {
                if (controller.signal.aborted) throw error;
                throw new Error('酒馆数据不是有效的 JSON', { cause: error });
            }
            if (!validate(value)) throw new Error('酒馆数据格式有误');
            seenFile = true;
            return value;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('读取酒馆数据超时，请检查网络后重试', { cause: error });
            if (error instanceof TypeError) throw new Error('无法连接酒馆读取数据，请检查网络后重试', { cause: error });
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    function ordered(action) {
        const result = pending.then(action);
        pending = result.catch(() => {});
        return result;
    }

    return {
        load: () => ordered(read),
        save: (base, next) => ordered(async () => {
            const latest = await read();
            if (JSON.stringify(latest) !== JSON.stringify(base)) {
                throw new Error('服务器数据已变化，为避免覆盖，请先复制当前编辑内容，再重新打开面板');
            }
            const bytes = new TextEncoder().encode(JSON.stringify(next));
            if (bytes.length > 40 * 1024 * 1024) throw new Error('数据超过 40 MB，无法保存');
            let response;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 45000);
            try {
                response = await fetcher('/api/files/upload', {
                    method: 'POST', headers: headers(),
                    body: JSON.stringify({ name: file, data: encode(bytes) }),
                    signal: controller.signal,
                });
            } catch (error) {
                throw new Error('保存结果无法确认，请重新打开面板检查', { cause: error });
            } finally {
                clearTimeout(timeout);
            }
            if (!response.ok) throw new Error('保存酒馆数据失败（' + response.status + '）');
            seenFile = true;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    if (JSON.stringify(await read()) === JSON.stringify(next)) return next;
                } catch { /* Retry transient read errors after a successful upload. */ }
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
            }
            throw new Error('保存请求已提交，但无法确认服务器数据，请重新打开面板检查');
        }),
    };
}
