/**
 * ModelManager — 模型发现、切换、凭证解析
 *
 * 管理 Pi SDK AuthStorage / ModelRegistry 基础设施，
 * 以及模型选择、provider 凭证查找、utility 配置解析。
 * 从 Engine 提取，Engine 通过 manager 访问模型状态。
 *
 * v2 新增：ProviderRegistry / ModelCatalog / AuthStore / ExecutionRouter
 * 四个新模块通过 init() 后挂载到实例，旧接口保持向后兼容。
 */
import path from "path";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { registerOAuthProvider } from "@mariozechner/pi-ai/oauth";
import { minimaxOAuthProvider } from "../lib/oauth/minimax-portal.js";
import { clearConfigCache, loadGlobalProviders, resolveApiKeyFromAuth, resolveOAuthCredentials } from "../lib/memory/config-loader.js";
import { t } from "../server/i18n.js";
import { ProviderRegistry } from "./provider-registry.js";
import { ModelCatalog } from "./model-catalog.js";
import { AuthStore } from "./auth-store.js";
import { ExecutionRouter } from "./execution-router.js";

function isLocalBaseUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

export class ModelManager {
  /**
   * @param {object} opts
   * @param {string} opts.hanakoHome - 用户数据根目录
   */
  constructor({ hanakoHome }) {
    this._hanakoHome = hanakoHome;
    this._authStorage = null;
    this._modelRegistry = null;
    this._defaultModel = null;   // 设置页面选的，持久化，bridge 用这个
    this._sessionModel = null;   // 聊天页面临时切的，只影响桌面端
    this._availableModels = [];

    // v2：新架构四层模块（init() 后可用）
    this.providerRegistry = new ProviderRegistry(hanakoHome);
    this.modelCatalog = null;   // 依赖 modelsJsonPath，init() 后创建
    this.authStore = null;
    this.executionRouter = null;
  }

  /** 初始化 AuthStorage + ModelRegistry + 新架构模块 */
  init() {
    this._authStorage = AuthStorage.create(path.join(this._hanakoHome, "auth.json"));
    registerOAuthProvider(minimaxOAuthProvider);
    this._modelRegistry = new ModelRegistry(
      this._authStorage,
      path.join(this._hanakoHome, "models.json"),
    );

    // v2 模块初始化
    this.providerRegistry.reload();
    this.modelCatalog = new ModelCatalog(this.providerRegistry, this.modelsJsonPath);
    this.authStore = new AuthStore(this._hanakoHome, this.providerRegistry);
    this.authStore.load();
    this.executionRouter = new ExecutionRouter(this.modelCatalog, this.authStore);
  }

  // ── Getters ──

  get authStorage() { return this._authStorage; }
  get modelRegistry() { return this._modelRegistry; }
  get defaultModel() { return this._defaultModel; }
  set defaultModel(m) { this._defaultModel = m; }
  get currentModel() { return this._sessionModel || this._defaultModel; }
  set currentModel(m) { this._sessionModel = m; }
  get availableModels() { return this._availableModels; }
  get modelsJsonPath() { return path.join(this._hanakoHome, "models.json"); }
  get authJsonPath() { return path.join(this._hanakoHome, "auth.json"); }

  /** 注入 PreferencesManager 引用（engine init 时调用） */
  setPreferences(prefs) { this._prefs = prefs; }

  /** 刷新可用模型列表 */
  async refreshAvailable() {
    this._availableModels = await this._modelRegistry.getAvailable();
    this._injectOAuthCustomModels();
    // v2：同步刷新 ModelCatalog
    if (this.modelCatalog) {
      await this.modelCatalog.build();
      const oauthCustom = this._prefs?.getOAuthCustomModels?.() || {};
      this.modelCatalog.injectOAuthCustomModels(oauthCustom);
      this.authStore?.load();
    }
    return this._availableModels;
  }

  /**
   * 将用户为 OAuth provider 添加的自定义模型注入到 availableModels
   * 从同 provider 的已有模型克隆 baseUrl / api / cost 等属性
   */
  _injectOAuthCustomModels() {
    const custom = this._prefs?.getOAuthCustomModels?.() || {};
    for (const [provider, modelIds] of Object.entries(custom)) {
      if (!Array.isArray(modelIds) || modelIds.length === 0) continue;
      // 找同 provider 的模板模型（继承 baseUrl、api、cost 等）
      let template = this._availableModels.find(m => m.provider === provider);
      if (!template) {
        // 无已有模型时从 providers.yaml 构建最小模板
        const gp = loadGlobalProviders().providers?.[provider];
        if (!gp?.base_url || !gp?.api) continue;
        template = {
          provider,
          baseUrl: gp.base_url,
          api: gp.api,
          input: ["text", "image"],
          contextWindow: 128_000,
        };
      }
      const existing = new Set(this._availableModels.filter(m => m.provider === provider).map(m => m.id));
      for (const id of modelIds) {
        if (existing.has(id)) continue;
        this._availableModels.push({
          ...template,
          id,
          name: id,
        });
      }
    }
  }

  /**
   * 同步 favorites → models.json，然后刷新 ModelRegistry
   * @param {string} configPath - agent config.yaml 路径
   * @param {object} opts
   * @returns {boolean}
   */
  async syncModelsAndRefresh(configPath, { favorites, sharedModels, authJsonPath }) {
    const { syncFavoritesToModelsJson } = await import("./sync-favorites.js");
    const synced = syncFavoritesToModelsJson(configPath, {
      modelsJsonPath: this.modelsJsonPath,
      favorites,
      sharedModels,
      authJsonPath: authJsonPath || this.authJsonPath,
    });
    if (synced) {
      clearConfigCache();
      this._modelRegistry.refresh();
      // refresh() 内部调 resetOAuthProviders()，需要重新注册
      registerOAuthProvider(minimaxOAuthProvider);
      this._availableModels = await this._modelRegistry.getAvailable();
      this._injectOAuthCustomModels();
      // v2：同步刷新 ModelCatalog + AuthStore
      if (this.modelCatalog) {
        await this.modelCatalog.refresh();
        const oauthCustom = this._prefs?.getOAuthCustomModels?.() || {};
        this.modelCatalog.injectOAuthCustomModels(oauthCustom);
        this.authStore?.invalidate();
        this.authStore?.load();
      }
    }
    return synced;
  }

  /**
   * 切换当前模型（只改状态，不推到 session）
   * @returns {object} 新模型对象
   */
  setModel(modelId) {
    const model = this._availableModels.find(m => m.id === modelId);
    if (!model) throw new Error(t("error.modelNotFound", { id: modelId }));
    this._sessionModel = model;
    return model;
  }

  /** auto → medium，其余原样 */
  resolveThinkingLevel(level) {
    return level === "auto" ? "medium" : level;
  }

  /**
   * 将模型引用（id/name/object）解析成 SDK 可用的模型对象
   */
  resolveExecutionModel(modelRef) {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef !== "string") return modelRef;
    const ref = modelRef.trim();
    if (!ref) return this.currentModel;
    const model = this._availableModels.find(m => m.id === ref || m.name === ref);
    if (!model) throw new Error(t("error.modelNotFound", { id: ref }));
    return model;
  }

  /** 根据模型 ID 推断其所属 provider */
  inferModelProvider(modelId) {
    return modelId ? this._availableModels.find(m => m.id === modelId)?.provider : null;
  }

  /**
   * 根据 provider 名称查找凭证
   * 查找顺序：全局 providers.yaml → config.yaml providers 块
   * @param {string} provider
   * @param {object} [agentConfig] - agent 的 config 对象
   */
  resolveProviderCredentials(provider, agentConfig) {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    let api_key = "", base_url = "", api = "";

    // 1. providers.yaml（全局配置）
    const globalProviders = loadGlobalProviders();
    const gp = globalProviders.providers?.[provider];
    if (gp?.api_key) api_key = gp.api_key;
    if (gp?.base_url) base_url = gp.base_url;
    if (gp?.api) api = gp.api;

    // 2. agent config（per-agent 覆盖）
    if ((!api_key || !base_url || !api) && agentConfig) {
      const provBlock = agentConfig.providers?.[provider];
      if (!api_key && provBlock?.api_key) api_key = provBlock.api_key;
      if (!base_url && provBlock?.base_url) base_url = provBlock.base_url;
      if (!api && provBlock?.api) api = provBlock.api;
    }

    // 3. auth.json（OAuth + 旧格式 API key）
    if (!api_key || !base_url || !api) {
      const oauth = resolveOAuthCredentials(provider);
      if (oauth) {
        if (!api_key) api_key = oauth.api_key;
        if (!base_url) base_url = oauth.base_url;
        if (!api) api = oauth.api;
      } else if (!api_key) {
        api_key = resolveApiKeyFromAuth(provider);
      }
    }

    return { api_key, base_url, api };
  }

  /**
   * 统一解析：模型引用 → { model, provider, api, api_key, base_url }
   * 所有消费方（chat、utility、memory、diary）都应通过此方法获取模型+凭证
   * @param {string|object} modelRef - 模型 ID / name / 对象
   * @param {object} [agentConfig] - agent config（用于 per-agent provider 回退）
   * @returns {{ model: string, provider: string, api: string, api_key: string, base_url: string }}
   */
  resolveModelWithCredentials(modelRef, agentConfig) {
    const entry = this.resolveExecutionModel(modelRef);
    const provider = entry?.provider;
    if (!provider) {
      throw new Error(t("error.modelNoProvider", { role: "resolve", model: String(modelRef) }));
    }
    const creds = this.resolveProviderCredentials(provider, agentConfig);
    if (!creds.api) {
      throw new Error(t("error.providerMissingApi", { provider }));
    }
    if (!creds.base_url || (!creds.api_key && !isLocalBaseUrl(creds.base_url))) {
      throw new Error(t("error.providerMissingCreds", { provider }));
    }
    return {
      model: entry.id,
      provider,
      api: creds.api,
      api_key: creds.api_key,
      base_url: creds.base_url,
    };
  }

  /**
   * 解析 utility 模型 + API 凭证完整配置
   * @param {object} agentConfig - agent config
   * @param {object} sharedModels - getSharedModels() 结果
   * @param {object} utilApi - getUtilityApi() 结果
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApi) {
    const cfg = agentConfig || {};

    const utilityModel = sharedModels?.utility || cfg.models?.utility;
    if (!utilityModel) {
      throw new Error(t("error.noUtilityModel"));
    }
    const largeModel = sharedModels?.utility_large || cfg.models?.utility_large;
    if (!largeModel) {
      throw new Error(t("error.noUtilityLargeModel"));
    }

    const utilityEntry = this.resolveExecutionModel(utilityModel);
    const largeEntry = this.resolveExecutionModel(largeModel);
    const utilProvider = utilityEntry?.provider || "";
    const largeProvider = largeEntry?.provider || "";

    if (!utilProvider) {
      throw new Error(t("error.modelNoProvider", { role: "utility", model: utilityModel }));
    }
    if (!largeProvider) {
      throw new Error(t("error.modelNoProvider", { role: "utility_large", model: largeModel }));
    }

    let api_key = "";
    let base_url = "";
    let api = "";
    if (utilApi?.provider || utilApi?.api_key || utilApi?.base_url) {
      if (utilApi.provider !== utilProvider) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: utilityModel }));
      }
      const providerConfig = this.resolveProviderCredentials(utilProvider, cfg);
      api = providerConfig.api || "";
      api_key = utilApi.api_key || "";
      base_url = utilApi.base_url || "";
      if (!api) {
        throw new Error(t("error.providerMissingApi", { provider: utilProvider }));
      }
      if (!base_url || (!api_key && !isLocalBaseUrl(base_url))) {
        throw new Error(t("error.utilityApiMissingCreds", { provider: utilProvider }));
      }
    } else {
      const creds = this.resolveProviderCredentials(utilProvider, cfg);
      api_key = creds.api_key;
      base_url = creds.base_url;
      api = creds.api;
      if (!api) {
        throw new Error(t("error.providerMissingApi", { provider: utilProvider }));
      }
      if (!base_url || (!api_key && !isLocalBaseUrl(base_url))) {
        throw new Error(t("error.providerMissingCreds", { provider: utilProvider }));
      }
    }

    // utility_large 凭证：provider 相同则复用，不同则独立解析
    let large_api_key = api_key, large_base_url = base_url, large_api = api;
    if (largeProvider && largeProvider !== utilProvider) {
      const creds = this.resolveProviderCredentials(largeProvider, cfg);
      large_api_key = creds.api_key;
      large_base_url = creds.base_url;
      large_api = creds.api;
      if (!large_api) {
        throw new Error(t("error.providerMissingApi", { provider: largeProvider }));
      }
      if (!large_base_url || (!large_api_key && !isLocalBaseUrl(large_base_url))) {
        throw new Error(t("error.providerMissingCreds", { provider: largeProvider }));
      }
    }

    return {
      utility: utilityModel,
      utility_large: largeModel,
      api_key,
      base_url,
      api,
      large_api_key,
      large_base_url,
      large_api,
    };
  }
}
