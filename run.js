const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- 配置信息 ---

// 接口地址
const API_BASE_URL = 'https://api.vocabili.top/v2/select/ranking';
const AUTH_REFRESH_URL = 'https://api.vocabili.top/v2/auth/refresh';

// 订阅接口 URL
const SUBSCRIBE_API_URL = 'http://127.0.0.1:41001/api/subscribe/BILIBILI/video';
const SUBSCRIBE_API_URL2 = 'http://127.0.0.1:7800/add';

// !!! 请将密钥替换为你的实际密钥 !!!
const API_KEY = '+}9Hl6b_(YX4aU12zThDqPn!fG08';
const API_SECRET = 'CHANGE_THIS_TO_A_STRONG_SECRET';

// 基础请求参数
const BASE_PARAMS = {
    board: 'vocaloid-daily',
    part: 'main',
    page_size: 20 // 每次获取20条
};

// 轮询配置
const POLLING_INTERVAL_MS = 60 * 1000; // 60秒
const DELAY_MS = 50; // 单次提交后的延迟 (毫秒)
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

// --- 本地状态文件配置 ---
const STATE_FILE_PATH = path.join(__dirname, 'issue_tracker.json');
const TOKEN_FILE_PATH = path.join(__dirname, 'token.json'); // [新增] Token 存储路径

// --- 鉴权状态变量 ---
let currentAccessToken = null;
let currentTokenType = 'Bearer';
let tokenExpirationTime = 0; // Token过期的绝对时间戳 (毫秒)

// !!! 填入你的初始 Refresh Token，仅在首次运行(本地无 token.json) 时使用 !!!
const INITIAL_REFRESH_TOKEN = 'YOUR_INITIAL_REFRESH_TOKEN_HERE';

/**
 * 延迟函数
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// [新增] Token 本地固化相关函数
// ==========================================
function loadRefreshToken() {
    try {
        if (fs.existsSync(TOKEN_FILE_PATH)) {
            const data = fs.readFileSync(TOKEN_FILE_PATH, 'utf8');
            const json = JSON.parse(data);
            if (json.refresh_token) {
                console.log('[系统] 成功从本地加载固化的 Refresh Token。');
                return json.refresh_token;
            }
        }
    } catch (error) {
        console.error('[警告] 读取 token 文件失败，将退回初始 Token:', error.message);
    }
    return null;
}

function saveRefreshToken(token) {
    try {
        const data = JSON.stringify({ refresh_token: token, last_updated: new Date().toISOString() }, null, 2);
        fs.writeFileSync(TOKEN_FILE_PATH, data, 'utf8');
        console.log('[系统] 新的 Refresh Token 已固化保存到本地。');
    } catch (error) {
        console.error('[错误] 写入 token 文件失败:', error.message);
    }
}

// [修改] 初始化当前的 Refresh Token (优先读取本地，否则用硬编码的)
let currentRefreshToken = loadRefreshToken() || INITIAL_REFRESH_TOKEN;
// ==========================================


/**
 * 检查并获取有效的 Access Token (带自动刷新逻辑)
 */
async function ensureAccessToken() {
    const BUFFER_TIME = 60 * 1000; 

    if (currentAccessToken && Date.now() < (tokenExpirationTime - BUFFER_TIME)) {
        return `${currentTokenType} ${currentAccessToken}`;
    }

    console.log('[鉴权] Access Token 为空或即将过期，正在请求刷新...');
    try {
        const response = await axios.post(
            AUTH_REFRESH_URL,
            { refresh_token: currentRefreshToken },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const data = response.data;
        currentAccessToken = data.access_token;
        currentTokenType = data.token_type || 'Bearer';
        tokenExpirationTime = Date.now() + (data.expires_in * 1000);

        // [修改] 如果服务端返回了新的 refresh_token 且与当前不同，则更新并固化
        if (data.refresh_token && data.refresh_token !== currentRefreshToken) {
            currentRefreshToken = data.refresh_token;
            saveRefreshToken(currentRefreshToken); 
        }

        console.log(`[鉴权] 刷新成功！新的 Access Token 有效期为 ${data.expires_in} 秒。`);
        return `${currentTokenType} ${currentAccessToken}`;
        
    } catch (error) {
        const status = error.response ? error.response.status : '网络异常';
        const msg = error.response && error.response.data ? JSON.stringify(error.response.data) : error.message;
        console.error(`[鉴权失败] 状态码: ${status} | 错误信息: ${msg}`);
        throw new Error('鉴权刷新失败，请检查 Refresh Token 是否已彻底失效。');
    }
}

/**
 * 读取本地记录的最后期数
 */
function loadLastIssue() {
    try {
        if (!fs.existsSync(STATE_FILE_PATH)) {
            return null;
        }
        const data = fs.readFileSync(STATE_FILE_PATH, 'utf8');
        return JSON.parse(data).last_issue || null;
    } catch (error) {
        return null;
    }
}

/**
 * 保存当前期数到本地文件
 */
function saveLastIssue(issue) {
    try {
        const data = JSON.stringify({ last_issue: issue, last_updated: new Date().toISOString() }, null, 2);
        fs.writeFileSync(STATE_FILE_PATH, data, 'utf8');
        console.log(`[系统] 已将最新期数 #${issue} 记录到本地文件。`);
    } catch (error) {
        console.error('[错误] 写入状态文件失败:', error.message);
    }
}

/**
 * 订阅指定的BVID
 */
async function subscribeVideo(bvid, silent = false) {
    try {
        if (!silent) console.log(`[POST] 正在提交 BVID: ${bvid} ...`);

        await axios.post(
            SUBSCRIBE_API_URL,
            { videoId: bvid },
            { headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' } }
        ).catch(e => { throw e; });

        await axios.post(
            SUBSCRIBE_API_URL2,
            { bvid: bvid },
            { headers: { 'x-api-secret': API_SECRET, 'Content-Type': 'application/json' } }
        );

        if (!silent) console.log(`[成功] BVID: ${bvid} 提交成功。`);
        return true;
    } catch (error) {
        const status = error.response ? error.response.status : '无响应';
        console.error(`[失败] BVID: ${bvid} 提交失败。状态: ${status} | 消息: ${error.message}`);
        return false;
    }
}

/**
 * 获取指定页面的数据
 */
async function fetchPageData(page, retryCount = 0) {
    try {
        const authHeader = await ensureAccessToken();
        const response = await axios.get(API_BASE_URL, {
            params: { ...BASE_PARAMS, page: page },
            headers: { 'Authorization': authHeader }
        });
        return response.data;
    } catch (error) {
        if (retryCount < MAX_RETRIES) {
            console.log(`[网络错误] 获取第 ${page} 页失败，${RETRY_DELAY_MS / 1000}秒后重试 (${retryCount + 1}/${MAX_RETRIES})...`);
            await sleep(RETRY_DELAY_MS);
            return fetchPageData(page, retryCount + 1);
        } else {
            throw new Error(`获取第 ${page} 页失败，已达最大重试次数: ${error.message}`);
        }
    }
}

/**
 * 执行整期周刊的导入任务
 */
async function processIssueImport(targetIssue) {
    console.log(`\n=== 开始导入第 #${targetIssue} 期周刊数据 ===`);
    let page = 1;
    let hasMore = true;
    let totalProcessed = 0;
    
    while (hasMore) {
        try {
            console.log(`[读取] 正在获取第 ${page} 页列表...`);
            const resData = await fetchPageData(page);
            const list = resData.data;

            if (!list || !Array.isArray(list) || list.length === 0) {
                console.log(`[读取] 第 ${page} 页无数据，停止获取。`);
                break;
            }

            for (const item of list) {
                if (item.issue !== targetIssue) {
                    if (item.issue < targetIssue) {
                        console.log(`[停止] 发现旧期数数据 (#${item.issue})，停止导入。`);
                        hasMore = false;
                        break;
                    }
                    continue; 
                }

                if (item.bvid) {
                    await subscribeVideo(item.bvid, true); 
                    totalProcessed++;
                    await sleep(DELAY_MS);
                }
            }

            const totalCount = resData.total || 0;
            const fetchedCount = (page - 1) * BASE_PARAMS.page_size + list.length;
            
            if (fetchedCount >= totalCount) {
                hasMore = false;
            } else {
                page++;
            }
        } catch (error) {
            console.error(`[处理中断] 处理第 ${page} 页时发生严重错误:`, error.message);
            hasMore = false; 
        }
    }

    console.log(`=== 第 #${targetIssue} 期处理完毕。共提交 ${totalProcessed} 个视频 ===\n`);
    return true;
}

/**
 * 主程序
 */
async function main() {
    console.log('--- Vocabili 自动订阅脚本 v3 (Token固化版) ---');
    console.log(`[配置] 状态文件: ${STATE_FILE_PATH}`);
    console.log(`[配置] Token文件: ${TOKEN_FILE_PATH}`);

    while (true) {
        try {
            let localLastIssue = loadLastIssue();
            const resData = await fetchPageData(1);
            
            if (resData && resData.data && resData.data.length > 0) {
                const latestItem = resData.data[0];
                const onlineIssue = latestItem.issue;

                if (!onlineIssue) {
                    console.error('[API错误] 无法解析最新期数 (issue 字段缺失)');
                } else {
                    if (localLastIssue === null || onlineIssue > localLastIssue) {
                        const isFirstRun = localLastIssue === null;
                        console.log(isFirstRun ? 
                            `[初始化] 首次运行，检测到最新期数为 #${onlineIssue}。立即开始更新...` : 
                            `[新刊发现] 线上期数 (#${onlineIssue}) > 本地期数 (#${localLastIssue})。开始更新...`);
                        
                        await processIssueImport(onlineIssue);
                        saveLastIssue(onlineIssue);
                    }
                }
            } else {
                console.warn('[API警告] 获取到的列表为空');
            }
        } catch (error) {
            console.error('[轮询异常] 主循环发生错误:', error.message);
        }

        await sleep(POLLING_INTERVAL_MS);
    }
}

// 启动
main();