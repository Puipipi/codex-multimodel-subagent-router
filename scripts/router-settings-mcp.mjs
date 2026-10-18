import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {
  createApiProfile,
  defaultRouterSettingsPath,
  readRouterSettingsSnapshot,
  resolveApiCredential,
  saveRouterSettings,
  validateRouterSettings,
} from './native-api-settings.mjs';
import {resolveDeepSeekAuth} from './native-credentials.mjs';

export const ROUTER_SETTINGS_URI = 'ui://router/settings';
export const ROUTER_SETTINGS_MIME = 'text/html;profile=mcp-app';
export const ROUTER_SETTINGS_SCHEMA = 'sol-luna-router-settings/v1';
export const ROUTER_SETTINGS_TOOL_NAMES = new Set([
  'router_settings_open',
  'router_settings_read',
  'router_settings_update',
  'router_settings_snapshot',
  'router_settings_save',
  'router_settings_save_profile',
  'router_settings_check_credential',
]);

const SETTINGS_TOOL_META = {ui: {visibility: ['app']}};
const SELECTOR_VALUES = new Set(['luna', 'deepseek']);
const CREDENTIAL_TYPES = new Set(['env', 'file', 'dsh_account']);
const PROTOCOL_VALUES = new Set(['responses', 'chat_completions']);
const EFFORT_VALUES = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const SHA256 = /^[a-f0-9]{64}$/;
const PROFILE_ID = /^[a-f0-9]{24}$/;

const emptyInput = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const hashInput = {
  type: ['string', 'null'],
  minLength: 64,
  maxLength: 64,
  pattern: '^[a-f0-9]{64}$',
  description: 'The exact sha256 returned by router_settings_snapshot or the previous save. Use null only when the file does not exist.',
};

const settingsReadResultSchema = {
  type: 'object',
  properties: {
    schema: {type: 'object', description: 'SettingsReadResult schema.'},
    values: {type: 'object', description: 'Current or default value for every settings property.'},
    layout: {type: 'array', items: {type: 'object'}, description: 'Optional grouping and tool actions.'},
  },
  required: ['schema', 'values'],
};

const snapshotOutputSchema = {
  type: 'object',
  properties: {
    schema: {type: 'string'},
    settings: {type: 'object'},
    sha256: {type: ['string', 'null']},
    saved: {type: 'boolean'},
    selectors: {type: 'array', items: {type: 'object'}},
    capabilities: {type: 'object'},
    status: {type: 'object'},
  },
  required: ['schema', 'settings', 'sha256', 'saved', 'selectors', 'capabilities', 'status'],
};

const saveOutputSchema = {
  type: 'object',
  properties: {
    ...snapshotOutputSchema.properties,
    previousSha256: {type: ['string', 'null']},
  },
  required: [...snapshotOutputSchema.required, 'previousSha256'],
};

const profileDefinition = {
  type: 'object',
  additionalProperties: false,
  properties: {
    protocol: {type: 'string', enum: [...PROTOCOL_VALUES]},
    baseUrl: {type: 'string'},
    model: {type: 'string'},
    reasoning: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supported: {type: 'array', items: {type: 'string', enum: [...EFFORT_VALUES]}},
        default: {type: 'string', enum: [...EFFORT_VALUES]},
        parameter: {type: 'string', enum: ['none', 'reasoning_effort', 'reasoning']},
      },
      required: ['supported', 'default', 'parameter'],
    },
    contextWindow: {
      type: 'integer',
      minimum: 1024,
      maximum: 2000000,
      description: 'Optional working context budget in tokens. An explicitly present value participates in the profile identity; an absent value preserves the old profile hash.',
    },
    credential: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {type: 'string', enum: [...CREDENTIAL_TYPES]},
        name: {type: 'string'},
        path: {type: 'string'},
      },
      required: ['type'],
    },
  },
  required: ['protocol', 'baseUrl', 'model', 'reasoning', 'credential'],
};

export const ROUTER_SETTINGS_TOOLS = [
  {
    name: 'router_settings_open',
    title: '路由设置',
    description: 'Open the compact router settings panel. It accepts an empty object and never starts a model turn.',
    inputSchema: emptyInput,
    outputSchema: {
      type: 'object',
      properties: {
        opened: {type: 'boolean'},
        resourceUri: {type: 'string'},
        message: {type: 'string'},
      },
      required: ['opened', 'resourceUri', 'message'],
    },
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    _meta: {
      ui: {resourceUri: ROUTER_SETTINGS_URI, visibility: ['model', 'app']},
      'openai/ui': {entrypoints: [{type: 'global'}, {type: 'thread'}]},
    },
  },
  {
    name: 'router_settings_read',
    title: '读取路由设置',
    description: 'Read the type-safe settings schema, current values, and layout. Accepts an empty object and never writes.',
    inputSchema: emptyInput,
    outputSchema: settingsReadResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_update',
    title: '更新路由设置',
    description: 'Update changed routing settings from the structured settings surface. CAS is used under the settings file lock.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        set: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            mode: {type: 'string', enum: ['auto', 'fixed', 'scheduled']},
            fixedExecutor: {type: 'string'},
            peak: {type: 'string'},
            valley: {type: 'string'},
          },
        },
        expectedSha256: hashInput,
      },
      required: ['set'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        values: {type: 'object'},
        sha256: {type: ['string', 'null']},
        pending: {type: 'object'},
      },
      required: ['values'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_snapshot',
    title: '读取路由设置快照',
    description: 'Read the full nested router settings and exact revision for the panel. Accepts an empty object.',
    inputSchema: emptyInput,
    outputSchema: snapshotOutputSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_save',
    title: '保存路由设置',
    description: 'Save the complete router settings with revision compare-and-swap. A stale revision is rejected; reload before retrying.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        settings: {type: 'object'},
        expectedSha256: hashInput,
      },
      required: ['settings', 'expectedSha256'],
    },
    outputSchema: saveOutputSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_save_profile',
    title: '保存 API 配置',
    description: 'Add or edit an API profile as a new immutable version. Credentials are references only; never send a key value.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expectedSha256: hashInput,
        basedOnProfileId: {type: ['string', 'null'], description: 'Existing profile being edited, or null for a new profile.'},
        definition: profileDefinition,
        label: {type: 'string'},
        aliases: {type: 'array', items: {type: 'string'}},
      },
      required: ['expectedSha256', 'definition'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ...snapshotOutputSchema.properties,
        profileId: {type: 'string'},
        created: {type: 'boolean'},
        supersedes: {type: ['string', 'null']},
        pending: {type: 'object'},
      },
      required: [...snapshotOutputSchema.required, 'profileId', 'created', 'supersedes', 'pending'],
    },
    annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
  {
    name: 'router_settings_check_credential',
    title: '检查本地凭据',
    description: 'Check whether a credential reference is locally available. Makes no API request and returns only a boolean.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        baseUrl: {type: 'string'},
        protocol: {type: 'string', enum: [...PROTOCOL_VALUES]},
        credential: profileDefinition.properties.credential,
      },
      required: ['baseUrl', 'protocol', 'credential'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        available: {type: 'boolean'},
        source: {type: 'string'},
        verified: {type: 'boolean'},
        reason: {type: 'string'},
        note: {type: 'string'},
      },
      required: ['available', 'source', 'verified', 'note'],
    },
    annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    _meta: SETTINGS_TOOL_META,
  },
];

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactObject(value, allowed, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
  }
  return value;
}

function requireEmpty(value, label) {
  exactObject(value ?? {}, new Set(), label);
}

function requireHash(value, label) {
  if (value === undefined) throw new Error(`${label} is required.`);
  if (value === null) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be a sha256 revision or null.`);
  return value;
}

function profileTitle(profile) {
  const label = typeof profile.label === 'string' && profile.label.trim() ? profile.label.trim() : profile.model;
  return label || profile.profileId;
}

export function selectorOptions(settings) {
  const values = [
    {value: 'luna', title: '原生 Luna', kind: 'builtin'},
    {value: 'deepseek', title: '原生 DeepSeek', kind: 'builtin'},
  ];
  const seen = new Set(values.map(item => item.value));
  const profiles = Object.values(settings.profiles ?? {}).sort((left, right) => profileTitle(left).localeCompare(profileTitle(right), 'zh-CN'));
  for (const profile of profiles) {
    if (!seen.has(profile.profileId)) {
      seen.add(profile.profileId);
      values.push({value: profile.profileId, title: profileTitle(profile), kind: 'profile'});
    }
    for (const alias of profile.aliases ?? []) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      values.push({value: alias, title: `${profileTitle(profile)}（${alias}）`, kind: 'alias'});
    }
  }
  return values;
}

function valuesFor(settings) {
  return {
    mode: settings.mode,
    fixedExecutor: settings.mode === 'fixed' ? settings.fixedExecutor ?? '' : '',
    peak: settings.schedule?.peak ?? 'luna',
    valley: settings.schedule?.valley ?? 'deepseek',
  };
}

function normalizeSelector(selector, settings) {
  if (typeof selector !== 'string' || !selector) throw new Error('执行器选择不能为空。');
  if (SELECTOR_VALUES.has(selector)) return selector;
  if (settings.profiles[selector]) return selector;
  const matches = Object.values(settings.profiles).filter(profile => profile.aliases?.includes(selector));
  if (matches.length === 1) return matches[0].profileId;
  throw new Error('执行器选择引用了未知或不唯一的 API 配置。');
}

function settingsReadResult(settings) {
  const options = selectorOptions(settings);
  const enumValues = [...new Set([...options.map(item => item.value), '', ...(settings.mode === 'fixed' ? [settings.fixedExecutor ?? ''] : []), settings.schedule?.peak, settings.schedule?.valley].filter(value => typeof value === 'string'))];
  return {
    schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          title: '路由模式',
          enum: ['auto', 'fixed', 'scheduled'],
          description: '自动按 DeepSeek 峰谷切换；固定模式只用一个执行器；自定义峰谷分别选择两个执行器。',
        },
        fixedExecutor: {
          type: 'string',
          title: '固定执行器',
          enum: enumValues,
          description: '仅固定模式使用。空值表示尚未选择。',
        },
        peak: {
          type: 'string',
          title: '高峰执行器',
          enum: enumValues.filter(Boolean),
          description: '仅自定义峰谷模式使用。',
        },
        valley: {
          type: 'string',
          title: '低谷执行器',
          enum: enumValues.filter(Boolean),
          description: '仅自定义峰谷模式使用。',
        },
      },
      required: ['mode', 'fixedExecutor', 'peak', 'valley'],
    },
    values: valuesFor(settings),
    layout: [
      {
        kind: 'group',
        title: '执行器',
        items: [
          {kind: 'property', property: 'mode'},
          {kind: 'property', property: 'fixedExecutor'},
          {kind: 'property', property: 'peak'},
          {kind: 'property', property: 'valley'},
        ],
      },
      {
        kind: 'group',
        title: 'API 配置',
        items: [
          {
            kind: 'tool',
            tool: 'router_settings_open',
            description: '打开完整面板，新增或编辑 API 配置。',
          },
        ],
      },
    ],
  };
}

function statusFor(saved, notice) {
  return {
    save: saved ? 'saved' : 'default',
    install: 'unknown',
    verify: 'not_verified',
    resolverReady: false,
    notice: notice ?? '面板只管理路由 JSON。安装、完整重启和验证需要在宿主侧单独完成；当前 resolver 尚未声明就绪。',
  };
}

function snapshotFor(snapshot, notice) {
  return {
    schema: ROUTER_SETTINGS_SCHEMA,
    settings: snapshot.settings,
    sha256: snapshot.sha256,
    saved: snapshot.sha256 !== null,
    selectors: selectorOptions(snapshot.settings),
    capabilities: {contextWindow: supportsContextWindow()},
    status: statusFor(snapshot.sha256 !== null, notice),
  };
}

function migrateSelectors(settings, previousId, nextId) {
  const next = {...settings};
  if (next.fixedExecutor === previousId) next.fixedExecutor = nextId;
  if (next.schedule) {
    next.schedule = {
      peak: next.schedule.peak === previousId ? nextId : next.schedule.peak,
      valley: next.schedule.valley === previousId ? nextId : next.schedule.valley,
    };
  }
  return next;
}

function normalizeSettingsSelectors(settings) {
  const profiles = settings.profiles && typeof settings.profiles === 'object' && !Array.isArray(settings.profiles)
    ? settings.profiles
    : {};
  const next = {...settings};
  if (settings.mode === 'fixed' && typeof settings.fixedExecutor === 'string' && settings.fixedExecutor) {
    next.fixedExecutor = normalizeSelector(settings.fixedExecutor, {profiles});
  }
  if (settings.mode === 'scheduled' && settings.schedule && typeof settings.schedule === 'object') {
    next.schedule = {
      peak: normalizeSelector(settings.schedule.peak, {profiles}),
      valley: normalizeSelector(settings.schedule.valley, {profiles}),
    };
  }
  return next;
}

function removeAlias(profile, alias) {
  const aliases = (profile.aliases ?? []).filter(value => value !== alias);
  const copy = {...profile};
  if (aliases.length) copy.aliases = aliases;
  else delete copy.aliases;
  return copy;
}

function credentialReason(type) {
  if (type === 'env') return '环境变量未设置或为空。';
  if (type === 'file') return '密钥文件不可读或为空。';
  return 'DeepSeek 账号凭据不可用。';
}

function credentialProfile(definition) {
  return createApiProfile({
    protocol: definition.protocol,
    baseUrl: definition.baseUrl,
    model: 'credential-check',
    reasoning: {supported: ['none'], default: 'none', parameter: 'none'},
    credential: definition.credential,
  });
}

const CONTEXT_WINDOW_PROBE = {
  protocol: 'responses',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'context-window-probe',
  reasoning: {supported: ['none'], default: 'none', parameter: 'none'},
  credential: {type: 'dsh_account'},
};

let contextWindowSupport;
function supportsContextWindow() {
  if (contextWindowSupport !== undefined) return contextWindowSupport;
  try {
    createApiProfile({...CONTEXT_WINDOW_PROBE, contextWindow: 128000});
    contextWindowSupport = true;
  } catch (error) {
    contextWindowSupport = /unsupported field/i.test(String(error?.message ?? '')) ? false : true;
  }
  return contextWindowSupport;
}

async function credentialIsAvailable(profile, {env, readSecretFile, resolveAccount}) {
  await resolveApiCredential(profile, {
    env,
    readSecretFile,
    resolveDeepSeekAuth: resolveAccount,
  });
}

export function createRouterSettingsService({
  settingsPath = defaultRouterSettingsPath(),
  env = process.env,
  readSecretFile,
  resolveAccount = resolveDeepSeekAuth,
  htmlPath = new URL('../ui/router-settings.html', import.meta.url),
} = {}) {
  let htmlPromise;
  function settingsHtml() {
    htmlPromise ??= readFile(htmlPath, 'utf8');
    return htmlPromise;
  }

  async function snapshot(notice) {
    return snapshotFor(await readRouterSettingsSnapshot(settingsPath), notice);
  }

  async function readSettings() {
    const current = await readRouterSettingsSnapshot(settingsPath);
    return settingsReadResult(current.settings);
  }

  async function updateSettings(args) {
    exactObject(args, new Set(['set', 'expectedSha256']), 'router_settings_update arguments');
    const set = exactObject(args.set, new Set(['mode', 'fixedExecutor', 'peak', 'valley']), 'set');
    if (!Object.keys(set).length) throw new Error('set must contain at least one setting.');
    const expected = args.expectedSha256 === undefined ? undefined : requireHash(args.expectedSha256, 'expectedSha256');
    const current = await readRouterSettingsSnapshot(settingsPath);
    const next = {...current.settings, profiles: {...current.settings.profiles}};
    if (set.mode !== undefined) {
      if (!['auto', 'fixed', 'scheduled'].includes(set.mode)) throw new Error('mode must be auto, fixed, or scheduled.');
      next.mode = set.mode;
    }
    if (set.fixedExecutor !== undefined) {
      if (typeof set.fixedExecutor !== 'string') throw new Error('fixedExecutor must be a selector string.');
      if (next.mode !== 'fixed') throw new Error('固定执行器仅在“固定执行器”模式生效；请同时切换模式。');
      next.fixedExecutor = set.fixedExecutor === '' ? null : normalizeSelector(set.fixedExecutor, next);
    }
    if (next.mode === 'fixed' && !next.fixedExecutor) throw new Error('固定模式需要选择一个执行器。');
    if (next.mode !== 'fixed') next.fixedExecutor = null;
    if (set.peak !== undefined || set.valley !== undefined) {
      if (next.mode !== 'scheduled') throw new Error('峰/谷执行器仅在“自定义峰谷”模式生效；请同时切换模式。');
      next.schedule = {
        peak: normalizeSelector(set.peak ?? next.schedule?.peak ?? 'luna', next),
        valley: normalizeSelector(set.valley ?? next.schedule?.valley ?? 'deepseek', next),
      };
    }
    validateRouterSettings(next);
    const saved = await saveRouterSettings(settingsPath, next, {
      expectedSha256: expected === undefined ? current.sha256 : expected,
    });
    return {
      values: valuesFor(saved.settings),
      sha256: saved.sha256,
      pending: {
        restartRequired: false,
        message: '设置已保存。安装与验证状态未由本工具改变。',
      },
    };
  }

  async function saveSettings(args) {
    exactObject(args, new Set(['settings', 'expectedSha256']), 'router_settings_save arguments');
    if (!plainObject(args.settings)) throw new Error('settings must be an object.');
    const expected = requireHash(args.expectedSha256, 'expectedSha256');
    const saved = await saveRouterSettings(settingsPath, normalizeSettingsSelectors(args.settings), {expectedSha256: expected});
    const result = snapshotFor({settings: saved.settings, sha256: saved.sha256}, '设置已保存。新增或修改的 API 角色仍需安装并完整重启；当前 resolver 尚未声明就绪。');
    return {...result, previousSha256: saved.previousSha256};
  }

  async function saveProfile(args) {
    exactObject(args, new Set(['expectedSha256', 'basedOnProfileId', 'definition', 'label', 'aliases']), 'router_settings_save_profile arguments');
    const expected = requireHash(args.expectedSha256, 'expectedSha256');
    if (!plainObject(args.definition)) throw new Error('definition must be an object.');
    const basedOnProfileId = args.basedOnProfileId ?? null;
    if (basedOnProfileId !== null && (typeof basedOnProfileId !== 'string' || !PROFILE_ID.test(basedOnProfileId))) {
      throw new Error('basedOnProfileId must be an existing 24-character profile id or null.');
    }
    if (args.label !== undefined && typeof args.label !== 'string') throw new Error('label must be a string.');
    if (args.aliases !== undefined && (!Array.isArray(args.aliases) || args.aliases.some(alias => typeof alias !== 'string'))) {
      throw new Error('aliases must be an array of strings.');
    }
    if (Object.hasOwn(args.definition, 'contextWindow')) {
      const contextWindow = args.definition.contextWindow;
      if (!Number.isInteger(contextWindow) || contextWindow < 1024 || contextWindow > 2000000) {
        throw new Error('contextWindow must be an integer between 1024 and 2000000 tokens.');
      }
      if (!supportsContextWindow()) {
        throw new Error('当前设置核心尚未支持 contextWindow；配置未保存。等待集成字段后重试。');
      }
    }
    const current = await readRouterSettingsSnapshot(settingsPath);
    if (expected !== current.sha256) throw new Error('router settings changed since they were read; reload before updating');
    const next = {
      ...current.settings,
      profiles: {...current.settings.profiles},
    };
    if (basedOnProfileId && !next.profiles[basedOnProfileId]) throw new Error('basedOnProfileId does not identify an existing profile.');
    const label = typeof args.label === 'string' ? args.label.trim() : undefined;
    const aliases = args.aliases === undefined
      ? undefined
      : [...new Set(args.aliases.map(alias => alias.trim()).filter(Boolean))];
    const profile = createApiProfile(args.definition, {
      label: label || undefined,
      aliases: aliases?.length ? aliases : undefined,
    });
    const profileId = profile.profileId;
    const created = !next.profiles[profileId];
    if (basedOnProfileId && basedOnProfileId !== profileId) {
      let old = next.profiles[basedOnProfileId];
      for (const alias of profile.aliases ?? []) {
        while (old?.aliases?.includes(alias)) {
          old = removeAlias(old, alias);
        }
      }
      next.profiles[basedOnProfileId] = old;
    }
    for (const alias of profile.aliases ?? []) {
      if (SELECTOR_VALUES.has(alias)) throw new Error(`alias “${alias}” 与内置执行器重名，未做任何修改。`);
      if (PROFILE_ID.test(alias)) throw new Error(`alias “${alias}” 不能使用 profile ID 形式，未做任何修改。`);
      if (next.profiles[alias] && alias !== basedOnProfileId) {
        throw new Error(`alias “${alias}” 与已有 profile ID 冲突，未做任何修改。`);
      }
      const owners = Object.values(next.profiles).filter(item => item.profileId !== profileId && item.aliases?.includes(alias));
      const foreign = owners.filter(item => item.profileId !== basedOnProfileId);
      if (foreign.length) throw new Error(`alias “${alias}” 已被另一个 API 配置占用；未做任何修改。`);
    }
    next.profiles[profileId] = profile;
    const migrated = basedOnProfileId && basedOnProfileId !== profileId
      ? migrateSelectors(next, basedOnProfileId, profileId)
      : next;
    validateRouterSettings(migrated);
    const saved = await saveRouterSettings(settingsPath, migrated, {expectedSha256: current.sha256});
    const newRole = created || Boolean(basedOnProfileId && basedOnProfileId !== profileId);
    const pending = newRole
      ? {
        restartRequired: true,
        message: '配置已保存；新增角色尚需安装并完整重启 Codex；当前 resolver 尚未声明就绪。',
      }
      : {
        restartRequired: false,
        message: '标签或别名已保存；API 定义未变，本次未新增角色。安装与验证状态仍需单独确认。',
      };
    const result = snapshotFor({settings: saved.settings, sha256: saved.sha256}, pending.message);
    return {
      ...result,
      profileId,
      created,
      supersedes: basedOnProfileId && basedOnProfileId !== profileId ? basedOnProfileId : null,
      pending,
    };
  }

  async function checkCredential(args) {
    exactObject(args, new Set(['baseUrl', 'protocol', 'credential']), 'router_settings_check_credential arguments');
    if (typeof args.baseUrl !== 'string' || !args.baseUrl.trim() || !PROTOCOL_VALUES.has(args.protocol)) throw new Error('baseUrl and protocol are required.');
    const credential = exactObject(args.credential, new Set(['type', 'name', 'path']), 'credential');
    if (!CREDENTIAL_TYPES.has(credential.type)) throw new Error('credential.type must be env, file, or dsh_account.');
    const profile = credentialProfile({
      baseUrl: args.baseUrl,
      protocol: args.protocol,
      credential,
    });
    let available = false;
    let reason;
    try {
      await credentialIsAvailable(profile, {
        env,
        readSecretFile: readSecretFile ?? (async file => {
          const info = await stat(file);
          if (!info.isFile() || info.size > 1024 * 1024) throw new Error('unavailable');
          const value = await readFile(file, 'utf8');
          if (!value.trim()) throw new Error('unavailable');
          return 'present';
        }),
        resolveAccount,
      });
      available = true;
    } catch {
      reason = credentialReason(credential.type);
    }
    return {
      available,
      source: credential.type,
      verified: false,
      ...(reason ? {reason} : {}),
      note: '仅检查本地凭据是否可用；未发起 API 请求，也未验证认证、余额或计费。',
    };
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case 'router_settings_open':
        requireEmpty(args, 'router_settings_open arguments');
        return {
          payload: {
            opened: true,
            resourceUri: ROUTER_SETTINGS_URI,
            message: '路由设置面板已打开。',
          },
          text: '路由设置面板已打开。',
        };
      case 'router_settings_read':
        requireEmpty(args, 'router_settings_read arguments');
        return {payload: await readSettings()};
      case 'router_settings_update':
        return {payload: await updateSettings(args)};
      case 'router_settings_snapshot':
        requireEmpty(args, 'router_settings_snapshot arguments');
        return {payload: await snapshot()};
      case 'router_settings_save':
        return {payload: await saveSettings(args)};
      case 'router_settings_save_profile':
        return {payload: await saveProfile(args)};
      case 'router_settings_check_credential':
        return {payload: await checkCredential(args)};
      default:
        throw new Error(`Unknown router settings tool: ${name}`);
    }
  }

  function listResources() {
    return [{
      uri: ROUTER_SETTINGS_URI,
      name: 'router_settings',
      title: '路由设置',
      description: '配置自动峰谷、固定执行器或独立峰/谷 API 执行器。',
      mimeType: ROUTER_SETTINGS_MIME,
    }];
  }

  async function readResource(uri) {
    if (uri !== ROUTER_SETTINGS_URI) throw new Error(`Resource not found: ${uri}`);
    return [{
      uri: ROUTER_SETTINGS_URI,
      mimeType: ROUTER_SETTINGS_MIME,
      text: await settingsHtml(),
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    }];
  }

  return {
    settingsPath: path.resolve(settingsPath),
    callTool,
    listResources,
    readResource,
  };
}
