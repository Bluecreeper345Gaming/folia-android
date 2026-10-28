package top.izuna.foliamajor;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * Folia Android 全屏沉浸容器：
 * - 真全屏（状态栏/导航栏全隐藏，IMMERSIVE_STICKY + WindowInsetsController 双通道）；
 * - 刘海屏 / 挖孔屏适配（API 30+ ALWAYS，低版本 SHORT_EDGES）；
 * - WebView：混合内容放行 + 75% 等比缩放（wideViewPort + overviewMode + initialScale）；
 * - 注册 FoliaBridge（网络层扩展）与 FoliaNative（本地音乐 MediaStore/SAF + LocalAudioServer）。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 调试包开放 WebView 远程调试（Chrome DevTools / CDP），便于在真机上直接排查界面与网络问题。
        boolean debuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            android.webkit.WebView.setWebContentsDebuggingEnabled(true);
        }
        registerPlugin(FoliaBridgePlugin.class);
        registerPlugin(FoliaCorePlugin.class);
        // 锁屏 / 通知栏的歌词通道：Web 层把整条时间轴交过来，由 ColorOsLyricBridge 写进
        // MediaMetadata["lyricInfo"]。这条线以前只有原生半边，Web 层从没调用过。
        registerPlugin(top.izuna.foliamajor.coloros.FoliaColorOsLyricsPlugin.class);
        super.onCreate(savedInstanceState);
        // 应用在前台时保持屏幕常亮：FLAG_KEEP_SCREEN_ON 只作用于本窗口，
        // 切到后台或锁屏后系统会自动忽略它，不需要额外监听生命周期去清。
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Bridge bridge = getBridge();
        if (bridge != null && bridge.getWebView() != null) {
            WebSettings ws = bridge.getWebView().getSettings();
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            ws.setUseWideViewPort(true);
            ws.setLoadWithOverviewMode(true);
            ws.setSupportZoom(false);
            ws.setBuiltInZoomControls(false);
            bridge.getWebView().setInitialScale(75);
        }
        applyFullscreen();
        applyCutoutMode();
        getWindow().getDecorView().postDelayed(this::applyFullscreen, 500);
        getWindow().getDecorView().postDelayed(this::applyCutoutMode, 500);
        getWindow().getDecorView().setOnSystemUiVisibilityChangeListener(visibility -> {
            if ((visibility & View.SYSTEM_UI_FLAG_FULLSCREEN) == 0) applyFullscreen();
        });
        // 返回键 / 全面屏返回手势先交给 WebView：JS 那边的层（弹窗、搜索、播放页、集合栈）退一层，
        // 真的回到主界面时由 JS 调 exitApp。emitBackPressed() 返回 false 说明 JS 还没装监听，
        // 这时才走系统默认（结束 Activity）。
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (FoliaCorePlugin.emitBackPressed()) return;
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyFullscreen();
            applyCutoutMode();
        }
    }

    private void applyFullscreen() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(android.view.WindowInsets.Type.statusBars() | android.view.WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        }
    }

    private void applyCutoutMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                attributes.layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            } else {
                attributes.layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            }
            getWindow().setAttributes(attributes);
        }
    }
}
