"use strict";
/**
 * compact-preset-migrate.ts — 受 EAC 管理 preset 的 dsh-compact 迁移。
 *
 * 只修改已知的完整 compaction group；解析前后都用 DSH YAML 方言校验，保留
 * BOM 与换行风格，并以备份加原子 rename 避免留下半写入配置。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DSH_YAML_SCHEMA = exports.MANAGED_PRESETS = exports.NEW_AGENT = exports.TRANSITION_ENGINE = exports.OLD_ENGINE = void 0;
exports.parsePreset = parsePreset;
exports.replaceCompactionGroup = replaceCompactionGroup;
exports.migratePresetFile = migratePresetFile;
exports.migrateManagedCompactPresets = migrateManagedCompactPresets;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const yaml = __importStar(require("js-yaml"));
exports.OLD_ENGINE = '@deepseek-ai/dsh-compaction-basic';
exports.TRANSITION_ENGINE = 'dsh-compact/engine';
exports.NEW_AGENT = 'dsh-compact/agent';
exports.MANAGED_PRESETS = [
    'anchored-standard',
    'router-standard',
    'v4-flash-godmode-opencode-go',
    'warmupbetter',
    'warmupbetter-replay',
    'whoami-standard',
    'zero-anchored-standard',
];
const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
});
exports.DSH_YAML_SCHEMA = yaml.JSON_SCHEMA.extend(jsExprType);
function parsePreset(text) {
    return yaml.load(text, { schema: exports.DSH_YAML_SCHEMA });
}
function readPrunerConfig(block) {
    const lines = block.split('\n');
    const start = lines.findIndex((line) => /^\s*-\s*id:\s*tool-result-pruner\s*(?:#.*)?$/.test(line));
    if (start < 0)
        return [];
    const result = [];
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/^\s*-\s*id:\s*/.test(line))
            break;
        const match = /^\s+(thresholdChars|headChars|tailChars):(\s*.+)$/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined)
            result.push(`    ${match[1]}:${match[2]}`);
    }
    return result;
}
function compactionSectionBodyStart(lines, groupIndex) {
    for (let i = groupIndex - 1; i >= 0; i--) {
        const line = (lines[i] ?? '').trim();
        if (line === '' || line.startsWith('#')) {
            if (/^# ── compaction\b/.test(line))
                return i + 1;
            continue;
        }
        break;
    }
    return groupIndex;
}
function replaceCompactionGroup(text) {
    if (!text)
        return { text, changed: false };
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!/^- id:\s*compaction\s*(?:#.*)?$/.test(lines[i] ?? ''))
            continue;
        let end = i + 1;
        while (end < lines.length && !/^- id:\s*/.test(lines[end] ?? '') && !/^# ── /.test(lines[end] ?? ''))
            end += 1;
        const block = lines.slice(i, end).join('\n');
        const hasEngine = [exports.OLD_ENGINE, exports.TRANSITION_ENGINE].some((name) => block.includes(`name: '${name}'`) || block.includes(`name: \"${name}\"`));
        if (!hasEngine || !/\bid:\s*command-compact\b/.test(block) || !/\bid:\s*tool-result-pruner\b/.test(block)) {
            return { text, changed: false };
        }
        const replacement = [
            '- id: compact-agent',
            `  name: '${exports.NEW_AGENT}'`,
            '  isolate:',
            '    compaction: true',
            '    toolResultPruner: true',
        ];
        const prunerConfig = readPrunerConfig(block);
        if (prunerConfig.length)
            replacement.push('  config:', ...prunerConfig);
        const start = compactionSectionBodyStart(lines, i);
        if (start < i) {
            replacement.unshift('', '# `dsh-compact/agent` keeps the engine, `/compact` command, and tool-result', '# pruner in one agent-local realm while exposing a single product-level entry.');
        }
        lines.splice(start, end - start, ...replacement);
        return { text: lines.join(eol), changed: true };
    }
    return { text, changed: false };
}
function migratePresetFile(file, log = () => { }) {
    let before;
    try {
        before = fs.readFileSync(file, 'utf8');
    }
    catch {
        return { status: 'missing', file };
    }
    try {
        parsePreset(before);
    }
    catch (error) {
        const message = String(error.message || error);
        log(`跳过无法解析的 preset: ${file}: ${message}`);
        return { status: 'invalid', file, error: message };
    }
    const replaced = replaceCompactionGroup(before);
    if (!replaced.changed)
        return { status: 'kept', file };
    try {
        parsePreset(replaced.text);
    }
    catch (error) {
        const message = String(error.message || error);
        log(`跳过迁移后无法解析的 preset: ${file}: ${message}`);
        return { status: 'invalid-result', file, error: message };
    }
    const backup = file + '.bak';
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
        if (!fs.existsSync(backup))
            fs.copyFileSync(file, backup);
        fs.writeFileSync(temporary, replaced.text, 'utf8');
        fs.renameSync(temporary, file);
        return { status: 'migrated', file, backup };
    }
    catch (error) {
        try {
            fs.rmSync(temporary, { force: true });
        }
        catch {
            /* 临时文件清理失败不覆盖原错误 */
        }
        const message = String(error.message || error);
        log(`迁移 preset 失败: ${file}: ${message}`);
        return { status: 'failed', file, error: message };
    }
}
function migrateManagedCompactPresets(presetsRoot, log) {
    return exports.MANAGED_PRESETS.map((name) => migratePresetFile(path.join(presetsRoot, name, 'agent.cordis.yml'), log));
}
