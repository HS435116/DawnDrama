#!/usr/bin/env python3
"""
斗破苍穹：无帝纪元 - 视频合并 + VAD+ASR识别 + 烧录字幕
整合到 AGNES 2.5 项目
"""

import os
import re
import subprocess
import tempfile
import glob
import shutil
import json
import sys

# ============ Configuration ============
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 随包携带的运行环境目录 (便携版/开发模式): <项目目录>/resources/
# 打包后真实资源位于 <安装目录>/resources/resources/, 由 electron-process-video.js
# 解析后通过 AGNES_FFMPEG / AGNES_ASR_MODEL 环境变量传入, 因此这里只作为本地直跑时的补充。
_BUNDLED_RES_DIRS = [
    os.path.join(BASE_DIR, 'resources'),
    os.path.join(os.path.dirname(BASE_DIR), 'resources'),
]


def _resolve_ffmpeg(raw):
    """把 ffmpeg 位置解析为 (ffmpeg, ffprobe)。
    同时接受"目录"(内含 ffmpeg.exe)与"ffmpeg.exe 的完整路径"两种写法，
    调用方(便携版把内置 ffmpeg 的路径传进来)与手工设置都能生效。
    解析不出来返回 None，交由后续回退逻辑处理。
    """
    if not raw:
        return None
    raw = raw.strip().strip('"')
    if os.path.isfile(raw):                                   # 直接给了 ffmpeg.exe / ffmpeg
        probe = os.path.join(os.path.dirname(raw), 'ffprobe.exe')
        return raw, (probe if os.path.isfile(probe) else raw)
    if os.path.isdir(raw):
        ff = os.path.join(raw, 'ffmpeg.exe')
        if os.path.isfile(ff):
            return ff, os.path.join(raw, 'ffprobe.exe')
    return None


def _resolve_ffmpeg_with_fallback():
    """解析顺序: AGNES_FFMPEG 环境变量 -> 随包 resources/ffmpeg -> 系统 PATH"""
    resolved = _resolve_ffmpeg(os.environ.get('AGNES_FFMPEG', ''))
    if resolved:
        return resolved
    for res_dir in _BUNDLED_RES_DIRS:
        resolved = _resolve_ffmpeg(os.path.join(res_dir, 'ffmpeg'))
        if resolved:
            return resolved
    return None


_FFMPEG_RESOLVED = _resolve_ffmpeg_with_fallback()
if _FFMPEG_RESOLVED:
    FFMPEG, FFPROBE = _FFMPEG_RESOLVED
else:
    # 最后回退到系统 PATH (需用户自行安装 ffmpeg)
    FFMPEG = os.environ.get('AGNES_FFMPEG', 'ffmpeg')
    FFPROBE = os.environ.get('AGNES_FFPROBE', 'ffprobe')


def _resolve_asr_model():
    """解析顺序: AGNES_ASR_MODEL 环境变量 -> 随包 resources/asr_model -> 空(未找到)"""
    candidates = [os.environ.get('AGNES_ASR_MODEL', '')]
    candidates += [os.path.join(d, 'asr_model') for d in _BUNDLED_RES_DIRS]
    for cand in candidates:
        if cand and os.path.isfile(os.path.join(cand, 'model.int8.onnx')):
            return cand
    return ''


# ★ ASR 模型路径: 未找到时留空, 由 asr_model_ready() 统一判定并降级为"无字幕成片"
MODEL_DIR = _resolve_asr_model()


def asr_model_ready():
    """ASR 模块与模型都就绪才返回 True"""
    return bool(ASR_AVAILABLE and MODEL_DIR
                and os.path.isfile(os.path.join(MODEL_DIR, 'model.int8.onnx')))

# OUTPUT_DIR 将由命令行参数决定; 默认保留用于手动运行
OUTPUT_DIR = os.path.join(BASE_DIR, 'output')

# ============ Import ASR ============
try:
    import sherpa_onnx
    import soundfile as sf
    ASR_AVAILABLE = True
except ImportError as e:
    print(f"⚠️ ASR 模块未安装: {e}")
    print("请安装依赖: pip install sherpa-onnx soundfile")
    ASR_AVAILABLE = False

# ============ VAD + ASR 参数 ============
VAD_SILENCE_DB = -38.0
VAD_MIN_SILENCE_DUR = 0.25
VAD_MIN_SPEECH_DUR = 0.4

MAX_SEGMENT_DURATION = 4.0
MAX_CHARS_IN_ONE_LINE = 25

MIN_CN_TEXT_LEN = 2
DROP_PURE_ENGLISH = True

MAX_CHARS_PER_LINE = 16

# 本次处理的字幕结果 (如实回报给上层: 成片有了 != 字幕烧上去了)。
#   三条降级路径 (ASR 缺失 / 没识别到语音 / 烧录失败) 以前也会 exit 0 报 success,
#   上层拿不到任何区分, 界面就一律显示"已烧录中文字幕" —— 这就是"假成功"。
_SUBTITLE_STATUS = {'burned': None, 'reason': '', 'path': ''}
# 本次是否真的做了合并: 单分镜不合并 (只出字幕), 上层据此区分"成片"与"原片+字幕"
_MERGED_STATUS = {'merged': True}


def _set_subtitle_status(burned, reason='', path=''):
    _SUBTITLE_STATUS['burned'] = bool(burned)
    _SUBTITLE_STATUS['reason'] = reason or ''
    _SUBTITLE_STATUS['path'] = path or _SUBTITLE_STATUS['path']


def _set_subtitle_path(path):
    _SUBTITLE_STATUS['path'] = path or ''


def _set_merged_status(merged):
    _MERGED_STATUS['merged'] = bool(merged)


def write_srt_file(subs, srt_out):
    """把识别结果写成 SRT (单分镜直接交付这个文件; 多分镜烧录前也用它)"""
    with open(srt_out, 'w', encoding='utf-8') as f:
        for i, (st, en, txt) in enumerate(subs, 1):
            wrapped = [txt[j:j + MAX_CHARS_PER_LINE]
                       for j in range(0, len(txt), MAX_CHARS_PER_LINE)]
            f.write(f"{i}\n{fmt_srt(st)} --> {fmt_srt(en)}\n"
                    f"{chr(10).join(wrapped)}\n\n")
    return srt_out


# ============ 字幕样式 ============
SUB_FONT_NAME = 'Microsoft YaHei'
SUB_FONT_SIZE = 20
SUB_PRIMARY_COLOUR = '&H00FFFFFF'
SUB_OUTLINE_COLOUR = '&H00000000'
SUB_OUTLINE = 2
SUB_MARGIN_V = 40


# ============ 阶段进度上报 ============
# 每进入一个阶段输出一行机器可读标记, 前端"生成进度"据此显示
# 音频识别 / 中文字幕烧录 的实时状态; 原有中文日志保持不变, 便于人工排查。
STAGE_PREFIX = '@@AGNES_STAGE@@'


def emit_stage(stage, message, current=None, total=None):
    """输出一条阶段进度标记 (异常时静默, 绝不影响合并流程)"""
    payload = {'stage': stage, 'message': message}
    if current is not None:
        payload['current'] = current
    if total is not None:
        payload['total'] = total
    try:
        print(f"{STAGE_PREFIX} {json.dumps(payload, ensure_ascii=False)}", flush=True)
    except Exception:
        pass


# ============ 工具函数 ============

def natural_sort_key(path):
    """自然排序：video_1 < video_2 < ... < video_9 < video_10 < ..."""
    name = os.path.basename(path)
    parts = re.split(r'(\d+)', name)
    key = []
    for p in parts:
        if p.isdigit():
            key.append((0, int(p)))
        else:
            key.append((1, p.lower()))
    return key


def get_media_duration(path):
    """获取媒体时长（秒），优先使用 ffprobe"""
    r = subprocess.run(
        [FFPROBE, '-v', 'error', '-show_entries',
         'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
        capture_output=True, text=True,
        encoding='utf-8', errors='ignore'
    )
    try:
        return float(r.stdout.strip())
    except (ValueError, TypeError):
        # 回退到 ffmpeg stderr
        r2 = subprocess.run(
            [FFMPEG, '-i', path, '-f', 'null', '-'],
            capture_output=True, text=True
        )
        m = re.search(r'Duration:\s*(\d+):(\d+):(\d+)\.(\d+)', r2.stderr)
        if m:
            h, mi, s, ms = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4).ljust(3, '0')[:3])
            return h * 3600 + mi * 60 + s + ms / 1000
    return 0.0


def concat_videos(video_paths, output_path):
    """用 ffmpeg concat demuxer 合并视频（不重新编码）"""
    listfile = os.path.join(tempfile.gettempdir(),
                            f'clip_merge_{os.getpid()}.txt')
    with open(listfile, 'w', encoding='utf-8') as f:
        for v in video_paths:
            p = os.path.abspath(v).replace('\\', '/').replace("'", r"'\''")
            f.write(f"file '{p}'\n")

    cmd = [FFMPEG, '-f', 'concat', '-safe', '0',
           '-i', listfile, '-c', 'copy', '-y', output_path]
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding='utf-8', errors='ignore')
    try:
        os.remove(listfile)
    except OSError:
        pass

    if r.returncode != 0:
        print(f"  ❌ 合并失败: {(r.stderr or '')[-300:]}")
        return False
    return True


def extract_audio(video_path, audio_path):
    """提取 16kHz 单声道 PCM WAV"""
    cmd = [FFMPEG, '-y', '-i', video_path,
           '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
           audio_path]
    return subprocess.run(cmd, capture_output=True).returncode == 0


# ============ VAD 语音检测 ============

def detect_speech_segments(audio_path):
    """用 ffmpeg silencedetect 检测语音段，返回 [(start, end), ...]"""
    cmd = [
        FFMPEG, '-i', audio_path,
        '-af', f'silencedetect=noise={VAD_SILENCE_DB}dB:d={VAD_MIN_SILENCE_DUR}',
        '-f', 'null', '-'
    ]
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding='utf-8', errors='ignore')
    stderr = r.stderr or ''
    total_dur = get_media_duration(audio_path)

    events = []
    for line in stderr.split('\n'):
        m = re.search(r'silence_start:\s*([\d.]+)', line)
        if m:
            events.append((float(m.group(1)), 'start'))
        m = re.search(r'silence_end:\s*([\d.]+)', line)
        if m:
            events.append((float(m.group(1)), 'end'))
    events.sort()

    speech = []
    is_silence = False
    cur_start = 0.0
    for t, kind in events:
        if kind == 'start':
            if not is_silence:
                if t > cur_start + 0.05:
                    speech.append((cur_start, t))
                cur_start = None
            is_silence = True
        else:
            if is_silence:
                cur_start = t
            is_silence = False

    if cur_start is not None and cur_start < total_dur - 0.05:
        speech.append((cur_start, total_dur))

    speech = [(s, e) for s, e in speech if e - s >= VAD_MIN_SPEECH_DUR]
    return speech


# ============ ASR 识别（VAD 驱动） ============

_RECOGNIZER = None


def get_recognizer():
    """懒加载 ASR 模型"""
    global _RECOGNIZER
    if _RECOGNIZER is None:
        if not asr_model_ready():
            raise RuntimeError(
                '未找到 ASR 模型 (model.int8.onnx)。请确认随包的 resources/asr_model 存在, '
                '或设置环境变量 AGNES_ASR_MODEL 指向模型目录。')
        _RECOGNIZER = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=os.path.join(MODEL_DIR, 'model.int8.onnx'),
            tokens=os.path.join(MODEL_DIR, 'tokens.txt'),
            num_threads=4,
            use_itn=True,
            debug=False,
        )
    return _RECOGNIZER


def recognize_by_vad(audio_path):
    """VAD 切分 + 逐段 ASR，再做过滤和二次切分"""
    if not ASR_AVAILABLE:
        return []

    audio, sr = sf.read(audio_path, dtype='float32')
    if len(audio) == 0:
        return []

    segments = detect_speech_segments(audio_path)
    if not segments:
        return []

    recognizer = get_recognizer()
    results = []

    for start, end in segments:
        i0 = int(start * sr)
        i1 = int(end * sr)
        seg = audio[i0:i1]
        if len(seg) < int(sr * VAD_MIN_SPEECH_DUR):
            continue

        stream = recognizer.create_stream()
        stream.accept_waveform(sr, seg)
        recognizer.decode_stream(stream)
        result = stream.result

        if not result or not result.text:
            continue
        text = result.text.strip()
        if is_noise_text(text):
            continue

        # 长段二次切分
        if (end - start) > MAX_SEGMENT_DURATION:
            for s, e, sub in split_long_text(start, end, text):
                if not is_noise_text(sub):
                    results.append((s, e, sub))
        else:
            results.append((start, end, text))

    return results


# ============ 后处理：过滤噪声 + 二次切分 ============

def is_noise_text(text):
    """判断是否为噪声文本"""
    t = text.strip()
    if not t:
        return True
    if t in ('.', '。', '<|nospeech|>'):
        return True
    if re.fullmatch(r'[，。！？、；：\.,!?;:\s]+', t):
        return True
    # 纯英文单字（Yeah. / The. / Oh.）
    if DROP_PURE_ENGLISH and re.fullmatch(r'[A-Za-z\.\s]+', t):
        if len(t.replace('.', '').strip()) <= 5:
            return True
    # 单个大写英文 + 句点
    if re.fullmatch(r'[A-Z][a-z]*\.', t):
        return True
    # 中文有效字数太少
    cn_chars = re.findall(r'[\u4e00-\u9fff]', t)
    if cn_chars and len(cn_chars) < MIN_CN_TEXT_LEN:
        return True
    return False


def split_long_text(start, end, text):
    """
    把长文本按标点/时长切分，时间戳按比例分配。
    关键改进：即使文本很短、没有标点，只要时长超限就按时间硬切。
    """
    duration = end - start
    t = text.strip()

    if duration <= MAX_SEGMENT_DURATION:
        return [(start, end, t)]

    # 按标点切分
    pieces = re.split(r'(?<=[。！？，；：,\.!?;:])', t)
    pieces = [p.strip() for p in pieces if p.strip()]

    # 只有 1 片（或没有标点）→ 按时间硬切，每段显示完整文本
    if len(pieces) <= 1:
        n = max(2, int(duration / MAX_SEGMENT_DURATION + 0.999))
        seg_dur = duration / n
        return [(start + i * seg_dur, start + (i + 1) * seg_dur, t)
                for i in range(n)]

    # 若某片仍超长，按字数切
    final = []
    for p in pieces:
        if len(p) > MAX_CHARS_IN_ONE_LINE:
            for j in range(0, len(p), MAX_CHARS_IN_ONE_LINE):
                final.append(p[j:j + MAX_CHARS_IN_ONE_LINE])
        else:
            final.append(p)

    # 按字符数比例分配时间
    total = sum(len(p) for p in final)
    result = []
    cursor = start
    for i, p in enumerate(final):
        if i == len(final) - 1:
            result.append((cursor, end, p))
        else:
            d = duration * len(p) / total
            result.append((cursor, cursor + d, p))
            cursor += d
    return result


def fmt_srt(sec):
    """秒 → SRT 时间戳 HH:MM:SS,mmm"""
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int((sec % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# ============ 字幕烧录 ============

def burn_subtitles(merged_path, srt_path, output_path):
    """用 ffmpeg subtitles 滤镜烧录中文字幕"""
    out_dir = os.path.dirname(os.path.abspath(output_path))
    orig_dir = os.getcwd()
    try:
        os.chdir(out_dir)

        style = (
            f"FontName={SUB_FONT_NAME},"
            f"Fontsize={SUB_FONT_SIZE},"
            f"PrimaryColour={SUB_PRIMARY_COLOUR},"
            f"OutlineColour={SUB_OUTLINE_COLOUR},"
            "BorderStyle=1,"
            f"Outline={SUB_OUTLINE},"
            "Shadow=0,"
            "Alignment=2,"
            f"MarginV={SUB_MARGIN_V}"
        )

        tmp_name = '_burn_tmp.mp4'
        cmd = [
            FFMPEG, '-y',
            '-i', os.path.abspath(merged_path),
            '-vf', f"subtitles='{os.path.basename(srt_path)}':charenc=UTF-8:force_style='{style}'",
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'copy',
            tmp_name,
        ]
        print(f"    ▶ 执行烧录命令...")
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding='utf-8', errors='ignore')

        if r.returncode != 0:
            print(f"    ❌ ffmpeg 返回码 {r.returncode}")
            print(f"    stderr 尾部:\n{(r.stderr or '')[-800:]}")
            return False

        if not os.path.exists(tmp_name):
            print(f"    ❌ 输出文件未生成")
            return False

        shutil.move(tmp_name, os.path.abspath(output_path))
        return True
    finally:
        os.chdir(orig_dir)


# ============ 核心处理 ============

def process_video_list(video_files, output_dir, final_name, display_name):
    """核心处理: 合并给定视频列表 + VAD+ASR识别 + 烧录字幕, 输出 <output_dir>/<final_name>。
    video_files 顺序即合并顺序; final_name 需带 .mp4 后缀; display_name 用于日志。
    返回最终视频绝对路径, 失败返回 None。
    """
    video_files = [os.path.abspath(v) for v in video_files]
    missing = [v for v in video_files if not os.path.isfile(v)]
    if missing:
        print(f"  ❌ 以下视频文件不存在: {missing}")
        emit_stage('error', '待合并的视频文件不存在')
        return None
    # 单分镜(1 个片段)不合并: 拼接一个文件只会白重编码一次, 画质白掉一档、还白等一分钟。
    # 这条路径只做"音频识别 + 生成中文字幕", 字幕以 <集名>_字幕.srt 交付, 原片保持原样不动。
    single_input = len(video_files) == 1
    if not video_files:
        print('  ⚠️ 没有可处理的视频文件')
        emit_stage('error', '没有可处理的视频文件')
        return None
    output_dir = os.path.abspath(output_dir)
    output_abs = os.path.abspath(os.path.join(output_dir, final_name))
    if output_abs in video_files:
        print(f"  ❌ 输出文件与输入视频同名: {output_abs}")
        emit_stage('error', '输出文件与输入视频同名')
        return None
    os.makedirs(output_dir, exist_ok=True)
    srt_path = None

    print(f"\n{'='*60}")
    print(f"🎬 处理: {display_name}  ({len(video_files)} 个片段)")
    print(f"{'='*60}")
    emit_stage('start', f'准备处理 {len(video_files)} 个分镜片段', 0, len(video_files))

    for vf in video_files:
        dur = get_media_duration(vf)
        print(f"  📎 {os.path.basename(vf)}  {dur:.2f}s")

    # Step 1: 拼接 (单分镜跳过)
    merged_path = os.path.join(output_dir, f'{os.getpid()}_合并临时.mp4')
    if single_input:
        merged_path = video_files[0]      # 单分镜: 直接用原片, 不重编码
        print(f"\n  ⏭️ 单分镜: 跳过拼接 (没有可合并的内容)")
        emit_stage('concat', '单分镜：跳过拼接')
    else:
        print(f"\n  🔗 合并视频中...")
        emit_stage('concat', '拼接分镜片段中')
        if not concat_videos(video_files, merged_path):
            print(f"  ❌ 合并失败，终止")
            emit_stage('error', '分镜拼接失败')
            return None

    _set_subtitle_status(None, '', '')   # 本次处理开始: 状态未知, 走完哪条分支就登记哪条
    _set_merged_status(not single_input)
    merged_dur = get_media_duration(merged_path)
    if not single_input:
        print(f"  ✅ 合并完成 ({merged_dur:.2f}s)")

    # Step 2: VAD + ASR 逐片段识别 (ASR 模块或模型缺失时降级: 多分镜输出无字幕成片 / 单分镜不产字幕)
    asr_ok = asr_model_ready()
    all_subs = []
    asr_reason = '' if asr_ok else (
        'ASR 未安装' if not ASR_AVAILABLE else f'未找到 ASR 模型 (MODEL_DIR={MODEL_DIR or "空"})')
    if asr_ok:
        print(f"\n  🎙️ VAD 切分 + ASR 识别中...")
        emit_stage('asr', '音频识别中 (VAD 切分 + ASR)', 0, len(video_files))
        offset = 0.0

        for idx, clip in enumerate(video_files, 1):
            clip_dur = get_media_duration(clip)
            audio_path = os.path.join(tempfile.gettempdir(),
                                      f'clip_{os.getpid()}.wav')
            if extract_audio(clip, audio_path):
                subs = recognize_by_vad(audio_path)
                try:
                    os.remove(audio_path)
                except OSError:
                    pass

                if subs:
                    subs = [(s + offset, e + offset, t) for s, e, t in subs]
                    all_subs.extend(subs)
                    preview = ' | '.join(t for _, _, t in subs[:6])[:60]
                    print(f"    {os.path.basename(clip)}: {len(subs)} 段 → {preview}")
                else:
                    print(f"    {os.path.basename(clip)}: (无声)")
            else:
                print(f"    {os.path.basename(clip)}: ⚠️ 音频提取失败")
            offset += clip_dur
            emit_stage('asr', f'音频识别中 (已识别 {idx}/{len(video_files)} 个片段, 累计 {len(all_subs)} 段语音)', idx, len(video_files))

        print(f"  📊 共识别 {len(all_subs)} 段语音")

    # ---------- 单分镜出口: 不合并、不烧录 (烧录要重编码, 会白掉一档画质), 字幕以文件交付 ----------
    if single_input:
        if not asr_ok:
            _set_subtitle_status(False, asr_reason)
            emit_stage('asr-unavailable', f'{asr_reason}，未生成字幕')
            print(f"  ⚠️ {asr_reason}，未生成字幕 (单分镜不合并, 原片保持原样)")
        elif not all_subs:
            _set_subtitle_status(False, '未识别到语音 (整集都是无对白音频)')
            emit_stage('no-speech', '未识别到语音，未生成字幕')
            print(f"  ⚠️ 未识别到语音，未生成字幕 (单分镜不合并, 原片保持原样)")
        else:
            srt_out = os.path.join(output_dir, f'{display_name}_字幕.srt')
            write_srt_file(all_subs, srt_out)
            emit_stage('srt', f'已识别 {len(all_subs)} 段语音，生成字幕文件')
            print(f"\n  📄 字幕文件: {os.path.basename(srt_out)}")
            # 单分镜: 不拼接, 但照样把字幕烧进画面 —— 只编码这一次, 输出 <集名>_完整版.mp4
            print(f"\n  🔥 烧录中文字幕中（字体: {SUB_FONT_NAME}, 字号: {SUB_FONT_SIZE}）...")
            emit_stage('burn', f'烧录中文字幕中 (字体: {SUB_FONT_NAME})')
            if burn_subtitles(video_files[0], srt_out, output_abs):
                _set_subtitle_status(True)
                _set_subtitle_path(srt_out)
                final_dur = get_media_duration(output_abs)
                print(f"  ✅ 完成: {final_name}  ({final_dur:.2f}s)")
                emit_stage('done', f'单分镜: 已烧录中文字幕 -> {final_name}')
                return output_abs
            # 烧录失败不能拿原片复制一份充数 (那只会多一个没字幕的副本), 原片保持原样
            _set_subtitle_status(False, '字幕烧录失败 (ffmpeg 执行出错)')
            _set_subtitle_path(srt_out)
            emit_stage('burn-failed', '字幕烧录失败，未生成带字幕的视频 (原片保持原样)')
            print(f"  ⚠️ 烧录失败，未生成带字幕的视频 (原片保持原样)")
        print(f"  ✅ 单分镜处理完成: {os.path.basename(video_files[0])}")
        return video_files[0]

    # ---------- 多分镜: 原有行为 —— 烧录字幕并输出完整版 ----------
    if not asr_ok:
        print(f"\n  ⚠️ {asr_reason}，仅输出合并视频（无字幕）")
        emit_stage('asr-unavailable', f'{asr_reason}，仅输出合并视频 (无字幕)')
        shutil.copy2(merged_path, output_abs)
        _set_subtitle_status(False, asr_reason)
        emit_stage('done', f'完成 (无字幕): {final_name}')
    elif not all_subs:
        print(f"  ⚠️ 未识别到任何语音，输出无字幕版本")
        emit_stage('no-speech', '未识别到语音，输出无字幕版本')
        shutil.copy2(merged_path, output_abs)
        _set_subtitle_status(False, '未识别到语音 (整集都是无对白音频)')
        emit_stage('done', f'完成 (无字幕): {final_name}')
    else:
        emit_stage('srt', f'已识别 {len(all_subs)} 段语音，生成字幕文件')

        # Step 3: 写 SRT
        print(f"\n  📊 前 10 条预览:")
        for i, (st, en, txt) in enumerate(all_subs[:10], 1):
            print(f"       {i}. [{fmt_srt(st)} → {fmt_srt(en)}] {en - st:.2f}s  {txt}")

        srt_path = os.path.join(output_dir, f'sub_{os.getpid()}.srt')
        write_srt_file(all_subs, srt_path)
        print(f"  📄 字幕文件: {os.path.basename(srt_path)}")

        # Step 4: 烧录字幕
        print(f"\n  🔥 烧录中文字幕中（字体: {SUB_FONT_NAME}, 字号: {SUB_FONT_SIZE}）...")
        emit_stage('burn', f'烧录中文字幕中 (字体: {SUB_FONT_NAME})')
        if burn_subtitles(merged_path, srt_path, output_abs):
            final_dur = get_media_duration(output_abs)
            print(f"  ✅ 完成: {final_name}  ({final_dur:.2f}s)")
            _set_subtitle_status(True)
            emit_stage('done', f'完成: {final_name} ({final_dur:.2f}s), 已烧录中文字幕')
        else:
            print(f"  ⚠️ 烧录失败，使用无字幕版本")
            emit_stage('burn-failed', '字幕烧录失败，已输出无字幕版本')
            shutil.copy2(merged_path, output_abs)
            _set_subtitle_status(False, '字幕烧录失败 (ffmpeg 执行出错)')


    # Clean up (单分镜时 merged_path 就是用户的原片, 绝不能删)
    if not single_input:
        try:
            os.remove(merged_path)
        except OSError:
            pass
    if srt_path:
        try:
            os.remove(srt_path)
        except OSError:
            pass

    return output_abs


def process_episode(episode_name, episode_dir, output_dir=None):
    """处理单集视频
    output_dir: 输出目录，默认为 episode_dir 自身（原地保存）
    """
    if output_dir is None:
        output_dir = episode_dir
    else:
        os.makedirs(output_dir, exist_ok=True)

    # Get video files sorted by name (排除已生成的完整版和临时文件)
    all_files = glob.glob(os.path.join(episode_dir, '*.mp4'))
    video_files = [
        f for f in all_files
        if '_完整版' not in os.path.basename(f)
        and not os.path.basename(f).startswith('tmp')
        and not os.path.basename(f).endswith('_tmp.mp4')
    ]
    video_files.sort(key=natural_sort_key)

    if not video_files:
        print(f"  ⚠️ 未找到视频文件: {episode_name}")
        return None

    return process_video_list(
        video_files, output_dir,
        f'{episode_name}_完整版.mp4', episode_name)


def scan_episodes(root_dir):
    """扫描根目录下所有含 video_*.mp4 的子目录"""
    episodes = []
    for entry in sorted(os.listdir(root_dir)):
        path = os.path.join(root_dir, entry)
        if os.path.isdir(path) and glob.glob(os.path.join(path, 'video_*.mp4')):
            episodes.append((entry, path))
    return episodes


def main():
    """主函数:
    1) python merge_videos.py                        扫描 OUTPUT_DIR 下全部剧集
    2) python merge_videos.py <剧集文件夹路径>        合并单个剧集目录
    3) python merge_videos.py --files "a.mp4|b.mp4" --out-name 成片 --out-dir D:\\out
       显式按给定顺序合并指定视频文件 (手动合并弹窗模式)
    """
    print("=" * 60)
    print("🎬 AGNES 2.5 - 视频合并 + VAD+ASR字幕烧录")
    print(f"   Python:   {sys.executable}")
    print(f"   ffmpeg:   {FFMPEG}")
    print(f"   ASR:      {'可用' if ASR_AVAILABLE else '未安装'}")
    print(f"   VAD:      {VAD_SILENCE_DB}dB / {VAD_MIN_SILENCE_DUR}s / 最长 {MAX_SEGMENT_DURATION}s")
    print(f"   ASR 模型: {MODEL_DIR or '(未找到 — 将输出无字幕成片)'}")
    print("=" * 60)

    args = sys.argv[1:]

    # ---------- 模式 3: 显式文件列表 ----------
    if args and args[0] == '--files':
        files_arg, out_name, out_dir = '', '', ''
        i = 0
        while i < len(args):
            if args[i] == '--files' and i + 1 < len(args):
                files_arg = args[i + 1]; i += 2
            elif args[i] == '--out-name' and i + 1 < len(args):
                out_name = args[i + 1]; i += 2
            elif args[i] == '--out-dir' and i + 1 < len(args):
                out_dir = args[i + 1]; i += 2
            else:
                i += 1
        video_files = [f.strip() for f in files_arg.split('|') if f.strip()]
        if not video_files:
            print(json.dumps({"success": False, "error": "未提供视频文件列表"}))
            sys.exit(1)
        if not out_dir:
            out_dir = os.path.dirname(os.path.abspath(video_files[0]))
        safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', out_name or '').strip() or '合并视频'
        result = process_video_list(video_files, out_dir, f'{safe_name}_完整版.mp4', safe_name)
        if result:
            print(json.dumps({"success": True, "result": {"finalVideoPath": result, "episodeName": safe_name, "subtitles": _SUBTITLE_STATUS["burned"], "subtitleReason": _SUBTITLE_STATUS["reason"], "merged": _MERGED_STATUS["merged"], "subtitlePath": _SUBTITLE_STATUS["path"]}}, ensure_ascii=False))
        else:
            print(json.dumps({"success": False, "error": "合并处理失败"}))
        sys.stdout.write("\n")
        sys.exit(0 if result else 1)

    episode_dir = args[0] if args else None

    if episode_dir:
        if not os.path.isdir(episode_dir):
            print(f"❌ 剧集文件夹不存在: {episode_dir}", file=sys.stderr)
            print(json.dumps({"success": False, "error": f"剧集文件夹不存在: {episode_dir}"}))
            sys.exit(1)
        episode_name = os.path.basename(episode_dir)
        result = process_episode(episode_name, episode_dir, output_dir=episode_dir)
        if result:
            print(json.dumps({"success": True, "result": {"finalVideoPath": result, "episodeName": episode_name, "subtitles": _SUBTITLE_STATUS["burned"], "subtitleReason": _SUBTITLE_STATUS["reason"], "merged": _MERGED_STATUS["merged"], "subtitlePath": _SUBTITLE_STATUS["path"]}}, ensure_ascii=False))
        else:
            print(json.dumps({"success": False, "error": "处理返回空结果"}))
        sys.stdout.write("\n")
    else:
        # 自动扫描
        episodes = scan_episodes(OUTPUT_DIR)
        if not episodes:
            # Fallback: find any directory with video_*.mp4
            all_dirs = glob.glob(os.path.join(OUTPUT_DIR, '*'))
            episodes = [(os.path.basename(d), d) for d in all_dirs
                        if os.path.isdir(d) and glob.glob(os.path.join(d, 'video_*.mp4'))]

        if not episodes:
            print(f"❌ 未找到任何剧集文件夹（请传入路径参数）")
            sys.exit(1)

        print(f"\n发现 {len(episodes)} 个剧集目录\n")

        success_count = 0
        for ep_name, ep_dir in episodes:
            if process_episode(ep_name, ep_dir):
                success_count += 1

        print(f"\n{'=' * 60}")
        print(f"✅ 完成: {success_count}/{len(episodes)} 集")
        print(f"{'=' * 60}")


if __name__ == '__main__':
    main()
