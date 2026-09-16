package com.kimju.claudeusage;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;

public class LoginActivity extends Activity {
    private WebView web;
    private String provider;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        provider = getIntent().getStringExtra(UsageService.EXTRA_PROVIDER);
        if (provider == null) provider = UsageService.CLAUDE;
        String name = UsageService.CLAUDE.equals(provider) ? "Claude" : "Codex";
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(16,16,16));
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(10,0,10,0);
        Button close = new Button(this); close.setText("닫기"); close.setTextColor(Color.WHITE); close.setAllCaps(false); close.setOnClickListener(v -> finish()); bar.addView(close, new LinearLayout.LayoutParams(0,56,1));
        Button done = new Button(this); done.setText(name + " 로그인 완료"); done.setTextColor(Color.WHITE); done.setAllCaps(false); done.setBackgroundColor(Color.rgb(217,119,87)); done.setOnClickListener(v -> { startService(new Intent(this, UsageService.class).setAction(UsageService.ACTION_REFRESH)); finish(); }); bar.addView(done, new LinearLayout.LayoutParams(-2,56)); root.addView(bar);
        web = new WebView(this); WebSettings s=web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setSupportZoom(false); CookieManager.getInstance().setAcceptCookie(true); web.setWebViewClient(new WebViewClient()); web.loadUrl(UsageService.CLAUDE.equals(provider) ? "https://claude.ai/login" : "https://chatgpt.com/auth/login?next=%2Fcodex%2Fcloud%2Fsettings%2Fanalytics"); root.addView(web, new LinearLayout.LayoutParams(-1,0,1)); setContentView(root);
    }
    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
