package com.todoreminder.web;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import androidx.core.content.FileProvider;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 待办提醒 · 一体包(手机数据为主)
 * 内嵌 Web 页面 + 手机本地服务器(127.0.0.1:8790) + 原生通知/闹钟:
 *   · 数据存手机本地(data/todos.json、periods.json), 以手机为主
 *   · 触摸即点即拖(不显示鼠标箭头), 长按/缩放/选择已禁用
 *   · 右上小齿轮: 重新载入 / 检查更新(一键更新) / 同步到电脑服务器 / 隐藏
 */
public class MainActivity extends Activity {

    private static final String PREFS = "gear";
    private static final String KEY_GEAR = "gearHidden";

    /** 内置电脑连接配置(可选手动同步用; 首次自动预填, 之后可用上次保存值) */
    private static final String DEF_PC_URL = "http://100.119.164.72:8790";
    private static final String DEF_PC_TOKEN = "7m1bRHHkY6KU";
    /**
     * 同步自动尝试的候选地址(上次成功/自定义/电脑端告知的远程入口会排最前):
     *   · 公网远程入口(电脑端自动建的隧道, 免 Tailscale / 免同一 Wi-Fi) —— 由电脑端在
     *     每次同步的响应里带下来并存在 pcRemoteUrl; 域名会变, 所以必须动态学习, 不能写死。
     *   · 下面是固定的兜底: Tailscale + 常见热点/局域网网段。
     */
    private static final String[] PC_URL_FALLBACKS = {
            DEF_PC_URL,
            "http://172.20.10.3:8790",
            "http://192.168.160.1:8790",
    };

    /** 组装候选地址: 上次成功的地址 → 电脑端告知的公网远程入口 → 固定兜底(去重) */
    private java.util.ArrayList<String> pcCandidates() {
        java.util.ArrayList<String> cand = new java.util.ArrayList<>();
        String stored = app.getPrefs().getPcUrl();
        if (stored != null && !stored.isEmpty()) cand.add(stored);
        String remote = app.getPrefs().getPcRemoteUrl();
        if (remote != null && !remote.isEmpty() && !cand.contains(remote)) cand.add(remote);
        for (String c : PC_URL_FALLBACKS) if (!cand.contains(c)) cand.add(c);
        return cand;
    }

    /** 从同步响应里学习/更新「电脑端公网远程入口」地址 */
    private void learnRemoteUrl(JSONObject syncResp) {
        try {
            JSONObject rm = syncResp == null ? null : syncResp.optJSONObject("remote");
            if (rm == null) return;
            String pub = rm.optString("publicUrl", "");
            if (pub == null || pub.isEmpty()) return;
            String old = app.getPrefs().getPcRemoteUrl();
            if (!pub.equals(old)) {
                app.getPrefs().setPcRemoteUrl(pub);
                appendCrashLog("learned remote entry: " + pub + (old.isEmpty() ? "" : " (旧值 " + old + ")"));
            }
            app.getPrefs().setPcRemoteLearnedAt(System.currentTimeMillis());
        } catch (Exception ignored) { }
    }

    private WebView web;
    private TextView gear;
    private App app;
    private LocalServer server;
    private int port = 8790;
    /** 渲染进程崩溃留痕与防循环 */
    private int renderGoneCount = 0;
    private long lastRenderGoneMs = 0;
    private boolean softRender = false; // 崩溃后是否处于软件渲染回退中
    private boolean permAsked = false;
    private boolean batteryAskPending = false; // 刚从“电池优化”设置页返回(用于给一次反馈)
    private File pendingInstall = null; // 等用户开启“安装未知应用”后自动继续安装

    // 齿轮拖动状态
    private float gDownX = 0, gDownY = 0;
    private int gLm0 = 0, gTm0 = 0;
    private boolean gMoved = false;
    /** 网络池: 多候选地址并行尝试, 谁先连通用谁(避免 10s 级串行超时链) */
    private final ExecutorService netPool = Executors.newFixedThreadPool(4);
    // AI 截图文件选择
    private android.webkit.ValueCallback<Uri[]> uploadCb = null;
    private static final int REQ_FILE_PICK = 9001;

    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        app = (App) getApplication();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LocalServer.Companion.prepareWebDir(this);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF2F4F9);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setBackgroundColor(Color.WHITE);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // 尽量降低渲染进程被系统回收的概率(白屏主因之一)
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }
        } catch (Exception ignored) { }
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String u) {
                Uri uri = Uri.parse(u);
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (scheme.equals("http") || scheme.equals("https")) v.loadUrl(u);
                return true;
            }

            // 崩溃回退软件渲染后: 页面加载完成且 20 秒内不再崩溃 → 恢复硬件加速(避免长期软渲染卡顿)
            @Override
            public void onPageFinished(WebView v, String url) {
                if (softRender) {
                    final int at = renderGoneCount;
                    v.postDelayed(() -> {
                        if (isDestroyed()) return;
                        if (renderGoneCount == at) {
                            try { v.setLayerType(View.LAYER_TYPE_HARDWARE, null); } catch (Exception ignored) { }
                            softRender = false;
                        }
                    }, 20000);
                }
            }

            // 渲染进程被杀(全屏白屏的主因): 自动重载恢复 + 崩溃留痕 + 防循环
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                final long nowMs = System.currentTimeMillis();
                if (nowMs - lastRenderGoneMs > 60000) renderGoneCount = 0;
                renderGoneCount++;
                lastRenderGoneMs = nowMs;
                try {
                    appendCrashLog("renderer-gone #" + renderGoneCount + " didCrash=" + detail.didCrash()
                            + " desc=" + String.valueOf(detail.toString()).replace('\n', ' ').substring(0, Math.min(160, String.valueOf(detail.toString()).length())));
                } catch (Exception ignored) { }
                view.postDelayed(() -> {
                    try {
                        if (renderGoneCount >= 3) {
                            // 连续崩溃: 停止无限重载, 加载极简页提示(无 JS, 不占内存)
                            toast("页面多次崩溃, 已停止自动恢复, 请重启 App");
                            view.loadDataWithBaseURL(null,
                                    "<html><body style='background:#f2f4f9;color:#444;font-family:sans-serif;padding:40px 20px;text-align:center'>"
                                            + "<h2 style='font-size:20px'>待办提醒 · 页面多次崩溃</h2>"
                                            + "<p style='font-size:14px;line-height:1.8'>请完全关闭 App 后重新打开;<br>仍频繁出现可到 ⚙→重建缓存并刷新。</p>"
                                            + "</body></html>",
                                    "text/html", "utf-8", null);
                        } else {
                            // 崩溃后切软件渲染再重载: 白屏多与 GPU/硬件加速 bug 有关(20 秒稳定后自动恢复硬件)
                            try {
                                if (!softRender) { view.setLayerType(View.LAYER_TYPE_SOFTWARE, null); softRender = true; }
                            } catch (Exception ignored) { }
                            view.reload();
                        }
                    } catch (Exception ignored) { }
                }, 500);
                toast(renderGoneCount >= 3 ? "页面多次崩溃, 请重启 App" : "页面进程重启, 已自动恢复");
                return true;
            }
        });
        // AI 截图/选图: 网页里的 <input type=file> 需要 WebChromeClient 转成系统选择器
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, android.webkit.ValueCallback<Uri[]> cb,
                                             android.webkit.WebChromeClient.FileChooserParams params) {
                if (uploadCb != null) uploadCb.onReceiveValue(null);
                uploadCb = cb;
                Intent pick = (params != null && params.createIntent() != null)
                        ? params.createIntent()
                        : new Intent(Intent.ACTION_GET_CONTENT).setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "选择图片/截图"), REQ_FILE_PICK);
                    return true;
                } catch (Exception e) {
                    uploadCb.onReceiveValue(null);
                    uploadCb = null;
                    return false;
                }
            }
        });
        web.setOnLongClickListener(v -> true); // 长按不弹菜单/不出现选择光标
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        gear = new TextView(this);
        gear.setText("⚙");
        gear.setTextSize(15f);
        gear.setTextColor(Color.WHITE);
        gear.setGravity(Gravity.CENTER);
        float d = getResources().getDisplayMetrics().density;
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(0x553F4A55);
        gear.setBackground(bg);
        gear.setTypeface(Typeface.DEFAULT_BOLD);
        FrameLayout.LayoutParams gp = new FrameLayout.LayoutParams((int) (42 * d), (int) (42 * d));
        gp.gravity = Gravity.END | Gravity.BOTTOM;
        gp.setMargins(0, 0, (int) (14 * d), (int) (26 * d));
        root.addView(gear, gp);
        final float slopPx = 6 * d;
        gear.setOnTouchListener((v, ev) -> {
            switch (ev.getActionMasked()) {
                case android.view.MotionEvent.ACTION_DOWN: {
                    gDownX = ev.getRawX();
                    gDownY = ev.getRawY();
                    FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) gear.getLayoutParams();
                    // 统一按 左上角坐标 计算(拖动期间动态改 gravity)
                    if (lp.gravity != (Gravity.TOP | Gravity.START)) {
                        android.view.ViewParent p = gear.getParent();
                        int pw = p instanceof android.view.View ? ((android.view.View) p).getWidth() : 0;
                        int ph = p instanceof android.view.View ? ((android.view.View) p).getHeight() : 0;
                        lp.gravity = Gravity.TOP | Gravity.START;
                        lp.topMargin = Math.max(0, ph - lp.bottomMargin - gear.getHeight());
                        lp.leftMargin = Math.max(0, pw - lp.rightMargin - gear.getWidth());
                        gear.setLayoutParams(lp);
                    }
                    gLm0 = lp.leftMargin;
                    gTm0 = lp.topMargin;
                    gMoved = false;
                    return true;
                }
                case android.view.MotionEvent.ACTION_MOVE: {
                    float dx = ev.getRawX() - gDownX;
                    float dy = ev.getRawY() - gDownY;
                    if (!gMoved && (Math.abs(dx) > slopPx || Math.abs(dy) > slopPx)) gMoved = true;
                    if (gMoved) {
                        android.view.ViewParent p = gear.getParent();
                        int pw = p instanceof android.view.View ? ((android.view.View) p).getWidth() : 0;
                        int ph = p instanceof android.view.View ? ((android.view.View) p).getHeight() : 0;
                        int maxL = Math.max(0, pw - gear.getWidth());
                        int maxT = Math.max(0, ph - gear.getHeight());
                        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) gear.getLayoutParams();
                        lp.leftMargin = Math.max(0, Math.min(maxL, gLm0 + (int) dx));
                        lp.topMargin = Math.max(0, Math.min(maxT, gTm0 + (int) dy));
                        gear.setLayoutParams(lp);
                    }
                    return true;
                }
                case android.view.MotionEvent.ACTION_UP:
                    if (!gMoved) showMenu();
                    return true;
                default:
                    return true;
            }
        });
        gear.setVisibility(getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_GEAR, false) ? View.GONE : View.VISIBLE);

        setContentView(root);

        // 本地服务器(先释放资源再启动)
        startLocalServer();
    }

    private void startLocalServer() {
        new Thread(() -> {
            int p = 8790;
            LocalServer srv = null;
            for (int i = 0; i < 8; i++) {
                try {
                    srv = new LocalServer(p, this, this::rescheduleNow);
                    srv.start();
                    break;
                } catch (Exception e) {
                    srv = null;
                    p++;
                }
            }
            final LocalServer started = srv;
            final int usedPort = p;
            ui.post(() -> {
                if (started == null) {
                    toast("本地服务启动失败");
                    return;
                }
                server = started;
                port = usedPort;
                web.loadUrl("http://127.0.0.1:" + usedPort + "/");
                askNotifyPermissions();
                autoFirstPcSync();
            });
        }).start();
    }

    /** 首次打开自动从电脑拉取一次(新装/清数据后, 仓库为空时免手动) */
    private void autoFirstPcSync() {
        ui.postDelayed(() -> {
            try {
                if (!app.getStore().active().isEmpty()) return; // 本机已有数据就不打扰
                String tok = app.getPrefs().getPcToken();
                runPcSync(tok == null || tok.isEmpty() ? DEF_PC_TOKEN : tok);
            } catch (Exception ignored) { }
        }, 6000);
    }

    /** 数据变化(每次本地 API 写入) → 去抖后重排闹钟(连续保存只重排一次) */
    private final Runnable reschedTask = () -> {
        final long t0 = System.currentTimeMillis();
        try {
            com.todoreminder.web.notify.ReminderScheduler.INSTANCE.rescheduleAll(this, app.getStore().all());
            com.todoreminder.web.notify.ReminderScheduler.INSTANCE.reschedulePeriods(this, app.getPeriodStore().all());
            appendCrashLog("resched ok " + (System.currentTimeMillis() - t0) + "ms");
        } catch (Exception e) {
            appendCrashLog("resched err " + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    };

    private void rescheduleNow() {
        ui.removeCallbacks(reschedTask);
        ui.postDelayed(reschedTask, 350); // 合并 350ms 内的连续保存(勾选/批量编辑)
    }

    // ---------- 资源占用自检(后台每 30s 采样, 数据进诊断信息) ----------
    private boolean perfArmed = false;
    private final Runnable perfTick = this::perfSample;

    private void perfSample() {
        try { com.todoreminder.web.util.PerfProbe.INSTANCE.tick(); } catch (Exception ignored) { }
        ui.postDelayed(perfTick, 30000);
    }

    private void armPerfProbe() {
        if (perfArmed) return;
        perfArmed = true;
        ui.postDelayed(perfTick, 30000);
    }

    // ---------- 每 15 分钟静默备份到电脑(不打扰界面; 失败静默, 下轮再试) ----------
    private boolean autoSyncArmed = false;
    private final java.util.concurrent.atomic.AtomicBoolean autoSyncBusy = new java.util.concurrent.atomic.AtomicBoolean(false);
    private static final long AUTO_SYNC_PERIOD_MS = 15 * 60 * 1000L;

    private void armAutoSync() {
        if (autoSyncArmed) return;
        autoSyncArmed = true;
        ui.postDelayed(this::autoSyncTick, AUTO_SYNC_PERIOD_MS);
    }

    private void autoSyncTick() {
        if (!autoSyncBusy.compareAndSet(false, true)) {
            ui.postDelayed(this::autoSyncTick, AUTO_SYNC_PERIOD_MS); // 上一轮未完成则顺延
            return;
        }
        new Thread(() -> {
            try {
                java.util.ArrayList<String> cand = pcCandidates();
                String tok = app.getPrefs().getPcToken();
                if (tok == null || tok.isEmpty()) tok = DEF_PC_TOKEN;
                final String token = tok;
                final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(cand.size());
                for (final String base : cand) {
                    netPool.execute(() -> {
                        try {
                            JSONArray todos = new JSONArray();
                            for (com.todoreminder.web.data.Todo t : app.getStore().all())
                                todos.put(com.todoreminder.web.data.Todo.Companion.toJson(t));
                            JSONArray periods = new JSONArray();
                            for (com.todoreminder.web.data.Period p : app.getPeriodStore().all())
                                periods.put(com.todoreminder.web.data.Period.Companion.toJson(p));
                            int up = new JSONObject().put("todos", todos).toString().length()
                                    + new JSONObject().put("periods", periods).toString().length();
                            String syncResp = httpJson("POST", base, "/api/sync", token,
                                    new JSONObject().put("todos", todos).toString(), 4000, 10000).toString();
                            httpJson("POST", base, "/api/periods/sync", token,
                                    new JSONObject().put("periods", periods).toString(), 4000, 10000);
                            try { learnRemoteUrl(new JSONObject(syncResp)); } catch (Exception ignored) { }
                            app.getPrefs().setLastPcSyncAt(System.currentTimeMillis());
                            com.todoreminder.web.util.PerfProbe.INSTANCE.addUpBytes(up);
                            com.todoreminder.web.util.PerfProbe.INSTANCE.noteSync(true);
                            appendCrashLog("auto-sync ok via " + base);
                        } catch (Exception e) {
                            String m = e.getMessage() == null ? e.toString() : e.getMessage();
                            com.todoreminder.web.util.PerfProbe.INSTANCE.noteSync(false);
                            appendCrashLog("auto-sync fail " + base + " :: " + m);
                        } finally {
                            latch.countDown();
                        }
                    });
                }
                latch.await(20, java.util.concurrent.TimeUnit.SECONDS);
            } catch (Exception e) {
                appendCrashLog("auto-sync err " + e.getMessage());
            } finally {
                autoSyncBusy.set(false);
                ui.postDelayed(this::autoSyncTick, AUTO_SYNC_PERIOD_MS); // 固定 15 分钟一轮
            }
        }).start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (server == null) return;
        rescheduleNow();
        armAutoSync(); // 每 15 分钟静默备份一次到电脑(进程存活期间)
        armPerfProbe(); // 后台资源占用自检(30s 采样)
        // 从“电池优化”设置页返回后给一次反馈(未授权也不重复弹窗)
        if (batteryAskPending) {
            batteryAskPending = false;
            if (com.todoreminder.web.notify.ReminderScheduler.INSTANCE.isIgnoringBatteryOptimizations(this))
                toast("已允许后台运行, 到点提醒将更可靠");
        }
        // 从“安装未知应用”设置页返回后, 若已授权则自动继续安装
        if (pendingInstall != null && Build.VERSION.SDK_INT >= 26 && getPackageManager().canRequestPackageInstalls()) {
            File f = pendingInstall;
            pendingInstall = null;
            launchInstall(f);
        }
    }

    // ---------- 通知 / 电池优化 / 精确闹钟 授权(一次性引导; 诊断可见状态) ----------
    private void askNotifyPermissions() {
        boolean needNotif = Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
                !permAsked;
        boolean needBattery = !com.todoreminder.web.notify.ReminderScheduler.INSTANCE
                .isIgnoringBatteryOptimizations(this) &&
                !getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("batteryAsked", false);
        boolean needExact = Build.VERSION.SDK_INT >= 31 &&
                !com.todoreminder.web.notify.ReminderScheduler.INSTANCE.canScheduleExact(this);

        if (needNotif) {
            permAsked = true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 101);
        }
        // 系统对话框与 AlertDialog 分开弹, 避免叠窗; 首次启动只各弹一次
        if (needBattery) ui.postDelayed(this::askBatteryOptimization, 700);
        if (needExact) ui.postDelayed(this::askExactAlarm, 1400);
    }

    /** 忽略电池优化: 后台不被 Doze/厂商省电清理 —— 到点提醒的前提(首次启动自动引导一次) */
    private void askBatteryOptimization() {
        if (isDestroyed()) return;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("batteryAsked", true).apply();
        showBatteryDialog();
    }

    /** 「允许后台运行」引导(可重复调起; 手动入口/页面按钮也走这里) */
    private void showBatteryDialog() {
        if (isDestroyed()) return;
        new AlertDialog.Builder(this)
                .setTitle("允许后台运行, 提醒才准时?")
                .setMessage("到点提醒由系统闹钟触发, 应用平时不耗电; 但部分手机会在省电清理时把应用\"彻底停止\", 导致之后的提醒全部失效。\n\n点击「去设置」后, 若系统弹出「允许…忽略电池优化」请选择允许; 跳转到设置列表则找到本应用开启。小米/华为/荣耀等机型还需到 设置→应用→待办提醒→自启动/后台运行 允许(各机型名称不同)。")
                .setPositiveButton("去设置", (d, w) -> {
                    batteryAskPending = true;
                    com.todoreminder.web.notify.ReminderScheduler.INSTANCE.openBatteryOptimizationSettings(this);
                })
                .setNegativeButton("暂不", null)
                .show();
    }

    /** 精确闹钟(Android 12+): 不授权也能收提醒, 但可能延迟几分钟 */
    private void askExactAlarm() {
        if (isDestroyed()) return;
        new AlertDialog.Builder(this)
                .setTitle("到点提醒更可靠?")
                .setMessage("允许「闹钟和提醒」后, 到点/提前提醒会准点到达; 不允许也能收到, 但可能延迟几分钟。")
                .setPositiveButton("去授权", (d, w) ->
                        com.todoreminder.web.notify.ReminderScheduler.INSTANCE.openExactAlarmSettings(this))
                .setNegativeButton("暂不", null)
                .show();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] grants) {
        super.onRequestPermissionsResult(code, perms, grants);
        rescheduleNow();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE_PICK) {
            if (uploadCb != null) {
                Uri u = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
                uploadCb.onReceiveValue(u == null ? null : new Uri[]{u});
                uploadCb = null;
            }
        }
    }

    // ---------- 齿轮菜单 ----------
    private void showMenu() {
        new AlertDialog.Builder(this)
                .setTitle("待办提醒 · 一体包(数据在本机)")
                .setItems(new String[]{"重新载入", "重建缓存并刷新(修复乱码/空白)", "⚡ 后台运行权限(允许后提醒才可靠)…", "诊断信息(排查用)", "检查更新(一键更新)", "同步到电脑服务器…", "隐藏右上小齿轮"}, (d, w) -> {
                    if (w == 0) web.reload();
                    else if (w == 1) rebuildCache();
                    else if (w == 2) showBatteryDialog();
                    else if (w == 3) showDiag();
                    else if (w == 4) checkUpdate();
                    else if (w == 5) askPcSync();
                    else {
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_GEAR, true).apply();
                        gear.setVisibility(View.GONE);
                        toast("小齿轮已隐藏(清除应用数据可恢复)");
                    }
                })
                .show();
    }

    /** 诊断: 汇总 本机仓库/网页引擎/连接状态, 便于排查“已同步但页面空白” */
    private void showDiag() {
        if (web == null) { toast("页面未就绪"); return; }
        final java.util.List<com.todoreminder.web.data.Todo> all = app.getStore().all();
        final java.util.List<com.todoreminder.web.data.Period> pal = app.getPeriodStore().all();
        int actT = 0, actP = 0;
        for (com.todoreminder.web.data.Todo t : all) if (!t.getDeleted()) actT++;
        for (com.todoreminder.web.data.Period p : pal) if (!p.getDeleted()) actP++;
        final String notifOk = Build.VERSION.SDK_INT >= 33
                ? (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ? "已允许" : "未允许(收不到通知!)")
                : "无需(系统版本低)";
        final String batteryOk = com.todoreminder.web.notify.ReminderScheduler.INSTANCE.isIgnoringBatteryOptimizations(this)
                ? "已忽略(提醒可靠)" : "未忽略(后台可能被杀/闹钟延迟!)";
        final String exactOk = com.todoreminder.web.notify.ReminderScheduler.INSTANCE.canScheduleExact(this)
                ? "已允许" : "未允许(提醒可能延迟几分钟)";
        final String nativeInfo = "本机仓库: 待办 " + actT + "/" + all.size() + ", 时段 " + actP + "/" + pal.size()
                + "\nApp 版本: " + ownVersion()
                + "\n本地服务: 端口 " + port + ", 运行=" + (server != null)
                + "\n电脑地址(上次成功): " + (app.getPrefs().getPcUrl().isEmpty() ? "(未设置)" : app.getPrefs().getPcUrl())
                + "\n电脑公网入口(学到的): " + (app.getPrefs().getPcRemoteUrl().isEmpty() ? "(还没学到 — 点「同步到电脑服务器」一次即可)"
                    : app.getPrefs().getPcRemoteUrl()
                      + (app.getPrefs().getPcRemoteLearnedAt() > 0
                         ? "  @" + String.format("%tF %tR", app.getPrefs().getPcRemoteLearnedAt(), app.getPrefs().getPcRemoteLearnedAt())
                         : ""))
                + "\n上次同步到电脑: " + (app.getPrefs().getLastPcSyncAt() > 0
                    ? String.format("%tF %tR", app.getPrefs().getLastPcSyncAt(), app.getPrefs().getLastPcSyncAt()) : "从未")
                + "\n系统权限: 通知=" + notifOk + ", 电池优化=" + batteryOk + ", 精确闹钟=" + exactOk
                + "\n资源占用: " + com.todoreminder.web.util.PerfProbe.INSTANCE.summary();
        web.evaluateJavascript(
                "(function(){try{var x=new XMLHttpRequest();x.open('GET','/api/health',false);x.send();window.__probe='health ' + x.status + ' / ' + String(x.responseText).slice(0,90);}catch(e){window.__probe='health ERR ' + e.message;}" +
                "var a=window.__todoApp;return JSON.stringify({todos:a?a.todos.length:-1,periods:a?a.periods.length:-1,conn:a?a.conn:'?',lastSync:a?a.lastSyncText:'',probe:window.__probe||'',errs:(window.__errs||[]).slice(-6),perf:(window.__perf||[]).slice(-8)});})();",
                value -> ui.post(() -> {
                    String js = value == null ? "(无返回值)" : String.valueOf(value).replace("\\\"", "\"");
                    // 本地日志尾部(含 [native] renderer-gone 崩溃记录)
                    String logTail = "";
                    try {
                        java.io.File lf = new java.io.File(getFilesDir(), "local-log.txt");
                        if (lf.exists()) {
                            String allLog = new String(java.nio.file.Files.readAllBytes(lf.toPath()), "UTF-8");
                            String[] lines = allLog.split("\n");
                            int from = Math.max(0, lines.length - 12);
                            StringBuilder sb = new StringBuilder();
                            for (int i = from; i < lines.length; i++) if (!lines[i].trim().isEmpty()) sb.append(lines[i]).append('\n');
                            logTail = sb.toString();
                        }
                    } catch (Exception ignored) { }
                    final String msg = nativeInfo + "\n\n网页引擎: " + js + "\n\n—— 本地日志尾部 ——\n" + logTail
                            + "\n若 probe 显示 health 200 但待办仍 0, 说明是同步/接口层问题; 若 probe ERR 说明本地服务不可达。";
                    new AlertDialog.Builder(this)
                            .setTitle("诊断信息(可复制)")
                            .setMessage(msg)
                            .setPositiveButton("复制全部", (d, w) -> {
                                try {
                                    android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                                    cm.setPrimaryClip(android.content.ClipData.newPlainText("diag", msg));
                                    toast("诊断已复制, 可直接粘贴发送");
                                } catch (Exception e) { toast("复制失败"); }
                            })
                            .setNegativeButton("知道了", null)
                            .show();
                }));
    }

    /** 清掉网页引擎的本地缓存(列表快照/游标), 重新从本地服务器拉取 — 可修复缓存里的乱码/残留 */
    private void rebuildCache() {
        if (web == null) { toast("页面未就绪"); return; }
        toast("正在重建页面缓存…");
        web.evaluateJavascript(
                "(function(){try{['tr:v1:todos','tr:v1:periods','tr:v1:meta'].forEach(function(k){localStorage.removeItem(k);});}catch(e){}" +
                "setTimeout(function(){location.reload();},150);})();", null);
    }

    // ---------- 一键更新(多候选地址并行尝试, 谁先连通用谁; 失败即刻快速失败) ----------
    private void checkUpdate() {
        toast("检查更新中…");
        final AtomicBoolean done = new AtomicBoolean(false);
        final AtomicReference<String> lastErr = new AtomicReference<>("");
        java.util.ArrayList<String> cand = pcCandidates();
        final AtomicInteger pending = new AtomicInteger(cand.size());
        for (final String base : cand) {
            netPool.execute(() -> {
                try {
                    if (done.get()) return;
                    String tok = app.getPrefs().getPcToken();
                    if (tok == null || tok.isEmpty()) tok = DEF_PC_TOKEN;
                    JSONObject j = httpJson("GET", base, "/api/phone/update", tok, null, 4000, 8000);
                    if (!j.optBoolean("ok", false)) throw new Exception("接口异常");
                    JSONObject latest = j.optJSONObject("latest");
                    if (done.compareAndSet(false, true)) {
                        final String used = base;
                        ui.post(() -> {
                            if (latest == null) {
                                toast("电脑端暂无手机版安装包(经 " + used + ")");
                                return;
                            }
                            final String ver = latest.optString("version", "");
                            final String url = latest.optString("url", "");
                            final int remoteCode = latest.optInt("versionCode", -1);
                            final String sha256 = latest.optString("sha256", "");
                            final int ownC = ownCode();
                            boolean newer;
                            if (remoteCode > 0) {
                                newer = remoteCode > ownC; // 权威判定: 数字版本号
                            } else {
                                // 旧服务端兜底: 语义版本字符串比较
                                final int[] own = parseVer(ownVersion());
                                final int[] up = parseVer(ver);
                                newer = up != null && (own == null || up[0] > own[0] || (up[0] == own[0] && (up[1] > own[1] || (up[1] == own[1] && up[2] > own[2]))));
                            }
                            if (!newer) { toast("已是最新版本 v" + ownVersion()); return; }
                            new AlertDialog.Builder(this)
                                    .setTitle("发现新版本 v" + ver)
                                    .setMessage("当前 v" + ownVersion() + " → 新版本 v" + ver
                                            + (remoteCode > 0 ? "(" + remoteCode + ")" : "")
                                            + "\n点击更新将下载并安装(约 3MB)。")
                                    .setPositiveButton("立即更新", (d, w) -> downloadAndInstall(used + url, sha256, remoteCode))
                                    .setNegativeButton("取消", null)
                                    .show();
                        });
                    }
                } catch (Exception e) {
                    String m = e.getMessage() == null ? e.toString() : e.getMessage();
                    if (!m.isEmpty()) lastErr.set(m);
                } finally {
                    if (pending.decrementAndGet() == 0 && !done.get()) {
                        final String err = lastErr.get();
                        ui.post(() -> toast("检查更新失败: 电脑端不可达(桌面软件需运行)\n" + err
                                + "\n提示: 电脑端开着时会自动建公网隧道; 首次或域名变化后, 请到 ⚙→「同步到电脑服务器」点一次「开始同步」让它把新地址告诉手机。"));
                    }
                }
            });
        }
    }

    /** 单候选 HTTP: body 为 null 时 GET, 否则 POST JSON(短超时, 并行尝试专用) */
    private JSONObject httpJson(String method, String base, String path, String token, String body,
                                int connectMs, int readMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            if (token != null && !token.isEmpty()) c.setRequestProperty("x-token", token);
            if (body != null) {
                c.setRequestProperty("content-type", "application/json");
                c.setDoOutput(true);
                c.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            InputStream is = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (is != null) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            }
            String text = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            if (code == 401) throw new Exception("连接码错误(401)");
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code + ": " + text.substring(0, Math.min(160, text.length())));
            return new JSONObject(text);
        } finally {
            c.disconnect();
        }
    }


    /** 下载中标志: 防止连点“立即更新”触发多次下载/多次失败 */
    private final java.util.concurrent.atomic.AtomicBoolean dlBusy = new java.util.concurrent.atomic.AtomicBoolean(false);

    /**
     * 一键下载更新包并安装; 全程显示进度对话框。
     * 版本闸门已前移到服务端清单(versionCode 数字比较), 这里只做:
     * ① SHA-256 完整性校验(不符自动重下一次); ② 解析包失败【不再阻止安装】(交系统安装器);
     * ③ 只有解析成功且版本号确实不高于本机时才提示“已是最新”。
     */
    private void downloadAndInstall(final String url, final String expectSha256, final int remoteCode) {
        if (!dlBusy.compareAndSet(false, true)) { toast("正在下载中…"); return; }
        final java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean(false);
        final android.app.AlertDialog[] dlg = new android.app.AlertDialog[1];
        final ProgressBar[] bar = new ProgressBar[1];
        final TextView[] tvSize = new TextView[1];
        final TextView[] tvSpeed = new TextView[1];
        ui.post(() -> {
            if (isDestroyed()) return;
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            int pad = (int) (20 * getResources().getDisplayMetrics().density);
            box.setPadding(pad, pad / 2, pad, 0);
            bar[0] = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
            bar[0].setMax(1000);
            tvSize[0] = new TextView(this);
            tvSize[0].setTextSize(13f);
            tvSize[0].setPadding(0, 14, 0, 4);
            tvSpeed[0] = new TextView(this);
            tvSpeed[0].setTextSize(12f);
            box.addView(bar[0]);
            box.addView(tvSize[0]);
            box.addView(tvSpeed[0]);
            dlg[0] = new AlertDialog.Builder(this)
                    .setTitle("正在下载更新…")
                    .setView(box)
                    .setNegativeButton("取消", (d, w) -> cancelled.set(true))
                    .setCancelable(false)
                    .show();
        });
        new Thread(() -> {
            try {
                File apkF = null;
                Exception lastErr = null;
                // 最多尝试 2 次(第一次哈希不符时自动重下一次)
                for (int attempt = 0; attempt < 2; attempt++) {
                    if (cancelled.get()) break;
                    apkF = fetchApkOnce(url, remoteCode, cancelled, dlg, bar, tvSize, tvSpeed);
                    if (apkF == null) break; // 已取消
                    if (expectSha256 == null || expectSha256.isEmpty()) break;
                    String got = sha256Of(apkF);
                    if (got != null && got.equalsIgnoreCase(expectSha256)) break;
                    try { apkF.delete(); } catch (Exception ignored) { }
                    apkF = null;
                    lastErr = new Exception("下载内容校验失败(SHA-256 不符)");
                    if (attempt == 0) ui.post(() -> { if (tvSpeed[0] != null) tvSpeed[0].setText("校验失败, 正在重新下载…"); });
                }
                if (cancelled.get()) {
                    if (apkF != null) { try { apkF.delete(); } catch (Exception ignored) { } }
                    ui.post(() -> { dismissDlg(dlg[0]); toast("已取消下载"); });
                    return;
                }
                if (apkF == null) {
                    final String msg = lastErr == null ? "下载失败" : lastErr.getMessage();
                    ui.post(() -> { dismissDlg(dlg[0]); toast("下载失败: " + msg + "\n可稍后重试, 或直接在电脑 dl 目录手动取安装包"); });
                    return;
                }
                // 解析下载包: 仅用于“确实不高于本机”的友好提示; 解析失败绝不阻止安装
                android.content.pm.PackageInfo pi = null;
                try { pi = getPackageManager().getPackageArchiveInfo(apkF.getAbsolutePath(), 0); } catch (Exception ignored) { }
                final int curCode = ownCode();
                if (pi != null && pi.versionCode <= curCode) {
                    final String newV = pi.versionName == null ? String.valueOf(pi.versionCode) : pi.versionName;
                    final File bad = apkF;
                    ui.post(() -> {
                        dismissDlg(dlg[0]);
                        toast("服务器上的更新包 v" + newV + " 不高于已安装 v" + ownVersion() + "\n请确认电脑端 dl 目录里的安装包已更新(发布时运行 scripts/make-version-json.mjs)。");
                    });
                    try { bad.delete(); } catch (Exception ignored) { }
                    return;
                }
                final File f = apkF;
                ui.post(() -> {
                    dismissDlg(dlg[0]);
                    toast("下载完成, 正在打开安装…");
                    installApk(f);
                });
            } catch (final Exception e) {
                final String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                ui.post(() -> { dismissDlg(dlg[0]); toast("下载失败: " + msg); });
            } finally {
                dlBusy.set(false);
            }
        }).start();
    }

    /** 单次下载(带进度), 成功返回文件; 取消返回 null */
    private File fetchApkOnce(String url, int remoteCode, java.util.concurrent.atomic.AtomicBoolean cancelled,
                              android.app.AlertDialog[] dlg, ProgressBar[] bar, TextView[] tvSize, TextView[] tvSpeed) throws Exception {
        long t0 = System.currentTimeMillis(), lastMs = t0, lastBytes = 0;
        double ema = 0;
        boolean hasEma = false;
        long total = -1, done = 0;
        File apkF = null;
        InputStream is = null;
        FileOutputStream fos = null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("GET");
            c.setConnectTimeout(10000);
            c.setReadTimeout(60000);
            String tok = app.getPrefs().getPcToken();
            if (tok == null || tok.isEmpty()) tok = DEF_PC_TOKEN;
            c.setRequestProperty("x-token", tok);
            int code = c.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);
            total = c.getContentLengthLong();
            File dir = new File(getCacheDir(), "update");
            dir.mkdirs();
            // 清理历史残留(含其它版本号的旧包), 避免任何旧文件被误装
            File[] olds = dir.listFiles();
            if (olds != null) for (File o : olds) try { o.delete(); } catch (Exception ignored) { }
            // 文件名带版本号: 每次更新都是新文件, 不复用旧路径
            apkF = new File(dir, "todo-update-" + (remoteCode > 0 ? remoteCode : System.currentTimeMillis()) + ".apk");
            is = c.getInputStream();
            fos = new FileOutputStream(apkF);
            byte[] buf = new byte[16384];
            int n;
            while (!cancelled.get() && (n = is.read(buf)) > 0) {
                fos.write(buf, 0, n);
                done += n;
                long now = System.currentTimeMillis();
                if (now - lastMs >= 150) {
                    double dt = (now - lastMs) / 1000.0;
                    double inst = (done - lastBytes) / dt;
                    ema = hasEma ? ema * 0.6 + inst * 0.4 : inst;
                    hasEma = true;
                    lastMs = now;
                    lastBytes = done;
                    final long d = done, t = total;
                    final double sp = ema;
                    ui.post(() -> paintDlProgress(dlg[0], bar[0], tvSize[0], tvSpeed[0], d, t, sp));
                }
            }
            if (cancelled.get()) return null;
            return apkF;
        } catch (Exception e) {
            if (apkF != null) { try { apkF.delete(); } catch (Exception ignored) { } }
            throw e;
        } finally {
            try { if (fos != null) fos.close(); } catch (Exception ignored) { }
            try { if (is != null) is.close(); } catch (Exception ignored) { }
            try { if (c != null) c.disconnect(); } catch (Exception ignored) { }
        }
    }

    /** 文件 SHA-256(大写十六进制); 失败返回 null */
    private static String sha256Of(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02X", b));
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private static void dismissDlg(android.app.AlertDialog d) {
        try { if (d != null) d.dismiss(); } catch (Exception ignored) { }
    }

    /** 进度对话框内容: 百分比条 + 已下载/总大小 + 速度 + 剩余 */
    private static void paintDlProgress(android.app.AlertDialog dlg, ProgressBar bar, TextView tvSize,
                                        TextView tvSpeed, long done, long total, double speed) {
        if (dlg == null || !dlg.isShowing()) return;
        if (total > 0) {
            bar.setIndeterminate(false);
            bar.setProgress((int) Math.min(1000, done * 1000 / total));
        } else {
            bar.setIndeterminate(true);
        }
        String size = (total > 0)
                ? "已下载 " + fmtMb(done) + " / 共 " + fmtMb(total) + " · " + Math.min(100, done * 100 / total) + "%"
                : "已下载 " + fmtMb(done);
        tvSize.setText(size);
        String spd;
        if (speed >= 1048576) spd = String.format(java.util.Locale.CHINA, "%.1f MB/s", speed / 1048576.0);
        else spd = String.format(java.util.Locale.CHINA, "%.0f KB/s", speed / 1024.0);
        long remainB = total - done;
        String rem = (total > 0) ? " · 还需 " + fmtMb(Math.max(0, remainB)) : "";
        String eta = "";
        if (total > 0 && speed > 0) {
            long sec = (long) Math.ceil(Math.max(0, remainB) / speed);
            eta = " · 约 " + (sec >= 60 ? (sec / 60) + " 分 " + (sec % 60) + " 秒" : sec + " 秒");
        }
        tvSpeed.setText("速度 " + spd + rem + eta);
    }

    private static String fmtMb(long bytes) {
        return String.format(java.util.Locale.CHINA, "%.2f MB", bytes / 1048576.0);
    }

    private int ownCode() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode; }
        catch (Exception e) { return 0; }
    }

    private void installApk(File apk) {
        // 先确保“安装未知应用”权限, 否则安装界面可能被系统静默丢弃
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            pendingInstall = apk;
            new AlertDialog.Builder(this)
                    .setTitle("需要允许「安装未知应用」")
                    .setMessage("更新包已下载完成。\n请允许本应用安装更新包(只用于安装官方更新); 开启后返回会自动继续安装。")
                    .setPositiveButton("去开启", (d, w) -> openInstallSettings())
                    .setNegativeButton("暂不", (d, w) -> pendingInstall = null)
                    .show();
            return;
        }
        launchInstall(apk);
    }

    private void openInstallSettings() {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                startActivity(i);
            }
        } catch (Exception e) {
            toast("请在系统设置 → 应用 → 待办提醒 → 允许「安装未知应用」");
        }
    }

    private void launchInstall(File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(i);
        } catch (Exception e) {
            toast("无法拉起安装: 请在系统设置 → 应用 → 待办提醒 → 允许「安装未知应用」后重试");
        }
    }

    private String ownVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception e) { return "0.0.0"; }
    }

    private static int[] parseVer(String v) {
        try {
            String[] p = (v == null ? "" : v).split("\\.");
            if (p.length < 3) return null;
            return new int[]{Integer.parseInt(p[0]), Integer.parseInt(p[1]), Integer.parseInt(p[2])};
        } catch (Exception e) { return null; }
    }

    private void askPcSync() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (14 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad / 2, pad, 0);
        EditText urlEt = new EditText(this);
        urlEt.setHint("电脑地址, 例: http://100.119.164.72:8790 或 https://xxx.trycloudflare.com");
        String curUrl = app.getPrefs().getPcUrl();
        if (curUrl.isEmpty()) {
            // 没成功过就优先填电脑端告知的公网远程入口(免 Tailscale、免同一 Wi-Fi)
            String remote = app.getPrefs().getPcRemoteUrl();
            curUrl = (remote == null || remote.isEmpty()) ? DEF_PC_URL : remote;
        }
        urlEt.setText(curUrl);
        EditText tokEt = new EditText(this);
        tokEt.setHint("连接码(电脑端 设置 → 同步 查看)");
        String curTok = app.getPrefs().getPcToken();
        tokEt.setText(curTok.isEmpty() ? DEF_PC_TOKEN : curTok);
        box.addView(urlEt);
        box.addView(tokEt);
        final String learnedRemote = app.getPrefs().getPcRemoteUrl();
        new AlertDialog.Builder(this)
                .setTitle("手动同步到电脑(双向 LWW, 各自较新者胜)")
                .setMessage("电脑端开着时会自动建一条公网隧道, 手机会自动学到它的地址并优先使用 —— 这样**不用 Tailscale、也不用同一个 Wi-Fi**。\n\n"
                        + "本机学到的公网入口: " + (learnedRemote.isEmpty() ? "(还没有 — 这次同步成功后就会学到)" : learnedRemote) + "\n\n"
                        + "地址与连接码已内置, 直接点「开始同步」; 会自动并行尝试多个地址(公网入口 / Tailscale / 热点网段)。\n\n"
                        + "注意: 电脑端桌面软件必须正在运行(右下角托盘有图标), 否则连不上。\n手机数据始终保留在本机, 不因同步丢失。")
                .setView(box)
                .setPositiveButton("开始同步", (d, w) -> {
                    final String url = urlEt.getText().toString().trim().replaceAll("/+$", "");
                    final String tok = tokEt.getText().toString().trim();
                    if (url.isEmpty()) { toast("请填写电脑地址"); return; }
                    app.getPrefs().setPcUrl(url);
                    app.getPrefs().setPcToken(tok);
                    runPcSync(tok);
                })
                .setNegativeButton("取消", null)
                .show();
    }

    /** 同步到电脑: 多候选地址并行尝试(自定义/上次成功排最前), 谁先成功用谁 */
    private void runPcSync(final String token) {
        java.util.ArrayList<String> cand = new java.util.ArrayList<>();
        String stored = app.getPrefs().getPcUrl();
        if (stored != null && !stored.isEmpty()) cand.add(stored);
        for (String c : PC_URL_FALLBACKS) if (!cand.contains(c)) cand.add(c);
        toast("同步中…(并行尝试 " + cand.size() + " 个地址)");
        final AtomicBoolean done = new AtomicBoolean(false);
        final AtomicReference<String> lastErr = new AtomicReference<>("");
        final AtomicReference<Boolean> authErr = new AtomicReference<>(false);
        final AtomicInteger pending = new AtomicInteger(cand.size());
        for (final String base : cand) {
            netPool.execute(() -> {
                try {
                    if (done.get()) return;
                    JSONArray todos = new JSONArray();
                    for (com.todoreminder.web.data.Todo t : app.getStore().all())
                        todos.put(com.todoreminder.web.data.Todo.Companion.toJson(t));
                    JSONArray periods = new JSONArray();
                    for (com.todoreminder.web.data.Period p : app.getPeriodStore().all())
                        periods.put(com.todoreminder.web.data.Period.Companion.toJson(p));

                    JSONObject r1 = httpJson("POST", base, "/api/sync", token,
                            new JSONObject().put("todos", todos).toString(), 4000, 10000);
                    JSONObject r2 = httpJson("POST", base, "/api/periods/sync", token,
                            new JSONObject().put("periods", periods).toString(), 4000, 10000);

                    java.util.List<com.todoreminder.web.data.Todo> nt = new java.util.ArrayList<>();
                    JSONArray at = r1.optJSONArray("todos");
                    if (at != null) for (int i = 0; i < at.length(); i++)
                        nt.add(com.todoreminder.web.data.Todo.Companion.fromJson(at.getJSONObject(i)));
                    java.util.List<com.todoreminder.web.data.Period> np = new java.util.ArrayList<>();
                    JSONArray ap = r2.optJSONArray("periods");
                    if (ap != null) for (int i = 0; i < ap.length(); i++)
                        np.add(com.todoreminder.web.data.Period.Companion.fromJson(ap.getJSONObject(i)));

                    app.getStore().adoptAll(nt);
                    app.getPeriodStore().adoptAll(np);
                    learnRemoteUrl(r1);                                    // 学习/更新电脑端公网入口地址
                    app.getPrefs().setLastPcSyncAt(System.currentTimeMillis());
                    if (!base.equals(app.getPrefs().getPcUrl())) app.getPrefs().setPcUrl(base); // 记住这次成功的地址
                    if (done.compareAndSet(false, true)) {
                        int actT = 0, actP = 0;
                        for (com.todoreminder.web.data.Todo t : nt) if (!t.getDeleted()) actT++;
                        for (com.todoreminder.web.data.Period p : np) if (!p.getDeleted()) actP++;
                        final String used = base;
                        final String msg = "同步成功(经 " + used + "): 待办 " + actT + " 个(共 " + nt.size() + "), 时段 " + actP + " 个(共 " + np.size() + ") — 正在刷新页面…";
                        ui.post(() -> {
                            rescheduleNow();
                            if (web != null) web.reload(); // 让页面立即向本地服务器取回并显示
                            ui.postDelayed(() -> toast(msg), 400);
                        });
                    }
                } catch (Exception e) {
                    String m = e.getMessage() == null ? e.toString() : e.getMessage();
                    if (!m.isEmpty()) lastErr.set(m);
                    if (m.contains("401") || m.contains("连接码")) authErr.set(true);
                } finally {
                    if (pending.decrementAndGet() == 0 && !done.get()) {
                        final String err = lastErr.get();
                        final String tried = String.join(" | ", cand);
                        final boolean aErr = authErr.get();
                        ui.post(() -> toast((aErr
                                ? "连接码错误: 请核对电脑端 设置→同步 里的连接码是否一致"
                                : "同步失败: 电脑端桌面软件可能未运行。\n(手机包会依次尝试: 上次成功的地址 / 电脑端告知的公网远程入口 / 局域网·Tailscale 兜底)") + "\n已尝试: " + tried + "\n最后错误: " + err));
                    }
                }
            });
        }
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    /** 把渲染进程崩溃等记录追加到 files/local-log.txt(与本地服务器同日志, 诊断信息可读) */
    private void appendCrashLog(String s) {
        try {
            java.io.File f = new java.io.File(getFilesDir(), "local-log.txt");
            String tail = "";
            if (f.exists()) {
                String old = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
                String[] lines = old.split("\n");
                tail = lines.length > 300
                        ? String.join("\n", java.util.Arrays.copyOfRange(lines, lines.length - 300, lines.length)) + "\n"
                        : old + (old.isEmpty() ? "" : "\n");
            }
            String line = System.currentTimeMillis() + " [native] " + s;
            java.nio.file.Files.write(f.toPath(), (tail + line).getBytes("UTF-8"));
        } catch (Exception ignored) { }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        try { if (server != null) server.stop(); } catch (Exception ignored) { }
        try { netPool.shutdownNow(); } catch (Exception ignored) { }
        super.onDestroy();
    }
}
