package com.kimju.claudeusage;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.view.Gravity;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class LoginActivity extends Activity {
    private WebView web;
    private TextView status;
    private String provider;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        provider = getIntent().getStringExtra(UsageService.EXTRA_PROVIDER);
        if (provider == null) provider = UsageService.CLAUDE;
        String name = UsageService.CLAUDE.equals(provider) ? "Claude" : "Codex";
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(250,249,245));
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(10,0,10,0); bar.setBackgroundColor(Color.rgb(20,20,19));
        Button close = new Button(this); close.setText("닫기"); close.setTextColor(Color.WHITE); close.setAllCaps(false); close.setOnClickListener(v -> finish()); bar.addView(close, new LinearLayout.LayoutParams(0,56,1));
        status = new TextView(this); status.setText(name + " 로그인 페이지 로딩 중…"); status.setTextColor(Color.LTGRAY); status.setTextSize(12); status.setGravity(Gravity.CENTER); bar.addView(status, new LinearLayout.LayoutParams(0,56,2));
        Button done = new Button(this); done.setText("로그인 완료"); done.setTextColor(Color.WHITE); done.setAllCaps(false); done.setBackgroundColor(Color.rgb(217,119,87)); done.setOnClickListener(v -> finishLogin()); bar.addView(done, new LinearLayout.LayoutParams(-2,56)); root.addView(bar);
        web = new WebView(this);
        WebSettings s = web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true); s.setSupportZoom(false); s.setJavaScriptCanOpenWindowsAutomatically(true); s.setSupportMultipleWindows(false); s.setUserAgentString(browserUserAgent(s.getUserAgentString()));
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setBackgroundColor(Color.rgb(250,249,245)); web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) { status.setText(name + " 로그인 페이지"); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) status.setText("페이지 로딩 실패 · 다시 시도하세요"); }
        });
        web.loadUrl(UsageService.CLAUDE.equals(provider) ? "https://claude.ai/login" : "https://chatgpt.com/auth/login?next=%2Fcodex%2Fcloud%2Fsettings%2Fanalytics"); root.addView(web, new LinearLayout.LayoutParams(-1,0,1)); setContentView(root);
    }

    private String browserUserAgent(String current) { return current.replace("; wv", "").replace(" Version/4.0", "") + " ClaudeUsageBar/1.0"; }
    private void finishLogin() { CookieManager.getInstance().flush(); Intent i=new Intent(this,UsageService.class).setAction(UsageService.ACTION_REFRESH); if(Build.VERSION.SDK_INT>=26)startForegroundService(i);else startService(i); finish(); }
    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
