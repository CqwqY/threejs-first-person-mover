package org.dpdns.graduate.fpm;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * 原生壳：沉浸式全屏 + 返回键接管。
 *
 * 锁横屏本身由 AndroidManifest 的 screenOrientation="sensorLandscape" 完成，这里不重复。
 *
 * 返回键：AppCompatActivity 的默认实现是直接 finish()，玩家在游戏里误触就当场退出。
 * 这里先问网页有没有自己消化（window.__fpmBack 返回非 false 就算消化了），
 * 没消化才走原生兜底 —— 两秒内再按一次才真退出。
 * 网页侧目前还没有定义 __fpmBack，所以现阶段表现为「再按一次退出」；
 * 将来在网页里加上这个钩子并部署，就能自动升级成「有面板先关面板」。
 */
public class MainActivity extends BridgeActivity {

    private static final long DOUBLE_BACK_MS = 2000L;

    /** 网页若定义 window.__fpmBack，即表示这次返回交给它处理。 */
    private static final String BACK_PROBE_JS =
        "(function(){try{"
            + "if(typeof window.__fpmBack==='function'){"
            + "var r=window.__fpmBack();if(r!==false)return 'handled';}"
            + "}catch(e){}return 'pass';})()";

    private long lastBackAt = 0L;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyImmersive();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 从后台切回、或被系统栏临时挤出后再收起一次
        if (hasFocus) applyImmersive();
    }

    /** 内容铺满刘海区，隐藏状态栏与导航栏；屏幕边缘上滑可临时唤出。 */
    private void applyImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            // 允许边缘上滑临时唤出系统栏，松手后自动隐藏 —— 免得玩家彻底出不去
            controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            super.onBackPressed();
            return;
        }
        WebView webView = bridge.getWebView();
        webView.evaluateJavascript(BACK_PROBE_JS, value -> {
            // evaluateJavascript 回传的是 JSON 字面量：处理过就是带引号的 "handled"
            if ("\"handled\"".equals(value)) return;
            confirmExit();
        });
    }

    /** 兜底：两秒内连按两次才真的退出，避免误触直接杀掉游戏。 */
    private void confirmExit() {
        long now = System.currentTimeMillis();
        if (now - lastBackAt < DOUBLE_BACK_MS) {
            finish();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, getString(R.string.back_exit_hint), Toast.LENGTH_SHORT).show();
    }
}
