package com.kimju.claudeusage;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONObject;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int NOTIFICATION_REQUEST = 20;
    private SharedPreferences prefs;
    private ProviderViews claudeViews, codexViews;
    private BroadcastReceiver receiver;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(16,16,16)); getWindow().setNavigationBarColor(Color.rgb(16,16,16));
        prefs = getSharedPreferences("usage", MODE_PRIVATE);
        if (prefs.getInt("icon_defaults_version", 0) < 2) prefs.edit().putBoolean("show_claude", true).putBoolean("show_codex", true).putInt("icon_defaults_version", 2).apply();
        setContentView(buildUi());
        renderProvider(UsageService.CLAUDE, UsageService.readStored(prefs, UsageService.CLAUDE));
        renderProvider(UsageService.CODEX, UsageService.readStored(prefs, UsageService.CODEX));
        if (prefs.getBoolean("status_icon_enabled", true) && anyProviderEnabled()) startUsageService(false);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
        receiver = new BroadcastReceiver() { @Override public void onReceive(Context c, Intent i) { if (UsageService.ACTION_USAGE.equals(i.getAction())) try { renderProvider(i.getStringExtra(UsageService.EXTRA_PROVIDER), new JSONObject(i.getStringExtra(UsageService.EXTRA_JSON))); } catch (Exception ignored) {} } };
        IntentFilter f = new IntentFilter(UsageService.ACTION_USAGE); if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, f, RECEIVER_NOT_EXPORTED); else registerReceiver(receiver, f);
    }

    @Override protected void onResume() {
        super.onResume();
        if (prefs != null) {
            renderProvider(UsageService.CLAUDE, UsageService.readStored(prefs, UsageService.CLAUDE));
            renderProvider(UsageService.CODEX, UsageService.readStored(prefs, UsageService.CODEX));
            if (anyProviderEnabled()) startUsageService(true);
        }
    }

    private View buildUi() {
        ScrollView scroll = new ScrollView(this); scroll.setBackgroundColor(Color.rgb(16,16,16));
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(20),dp(18),dp(20),dp(24));
        root.addView(label("AI USAGE BAR",12,Color.rgb(217,119,87),true));
        TextView title=label("사용량 한눈에 보기",30,Color.WHITE,true); title.setPadding(0,dp(6),0,dp(2)); root.addView(title);
        root.addView(label("상단바 숫자와 알림에서 Claude·Codex 사용량을 확인합니다. 1분마다 자동 갱신됩니다.",14,Color.rgb(175,175,175),false));
        root.addView(overviewRow(), cardParams(20,14));
        root.addView(providerCard(UsageService.CLAUDE,"Claude",Color.rgb(217,119,87)), cardParams(24,14));
        root.addView(providerCard(UsageService.CODEX,"Codex",Color.rgb(92,118,180)), cardParams(0,14));
        Button refresh=button("두 서비스 지금 새로고침",true); refresh.setOnClickListener(v->startUsageService(true)); root.addView(refresh,fullParams(8));
        root.addView(settingsRow(),cardParams(10,0));
        Button claudeLogin=button("Claude 로그인 / 다시 로그인",false); claudeLogin.setOnClickListener(v->openLogin(UsageService.CLAUDE)); root.addView(claudeLogin,fullParams(10));
        Button codexLogin=button("Codex 로그인 / 다시 로그인",false); codexLogin.setOnClickListener(v->openLogin(UsageService.CODEX)); root.addView(codexLogin,fullParams(10));
        root.addView(label("참고",16,Color.WHITE,true),fullParams(26));
        TextView help=label("로그인 완료를 누르면 서비스별 WebView 세션을 저장하고 즉시 사용량을 확인합니다. 화면 구조가 바뀌면 일시적으로 읽지 못할 수 있습니다.",14,Color.rgb(170,170,170),false); help.setLineSpacing(dp(3),1f); root.addView(help); scroll.addView(root); return scroll;
    }

    private View overviewRow() {
        LinearLayout box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(18),dp(15),dp(18),dp(15)); box.setBackgroundResource(R.drawable.bg_card);
        box.addView(label("상단 요약",13,Color.rgb(190,190,190),true));
        box.addView(overviewProvider(UsageService.CLAUDE,"Claude",Color.rgb(217,119,87)), new LinearLayout.LayoutParams(-1,dp(76)));
        box.addView(overviewProvider(UsageService.CODEX,"Codex",Color.rgb(92,118,180)), new LinearLayout.LayoutParams(-1,dp(76)));
        return box;
    }

    private View overviewProvider(String provider,String name,int accent) {
        ProviderViews v=viewsFor(provider); LinearLayout row=new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL);
        TextView mark=label("C",30,Color.WHITE,true); mark.setGravity(Gravity.CENTER); mark.setPadding(0,0,0,dp(2)); GradientDrawable markBg=new GradientDrawable(); markBg.setColor(accent); markBg.setCornerRadius(dp(18)); mark.setBackground(markBg); row.addView(mark,new LinearLayout.LayoutParams(dp(58),dp(58)));
        TextView n=label(name,15,Color.WHITE,true); n.setGravity(Gravity.CENTER_VERTICAL); n.setPadding(dp(13),0,dp(8),0); row.addView(n,new LinearLayout.LayoutParams(0,-1,1));
        LinearLayout metricBox=new LinearLayout(this); metricBox.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout session=new LinearLayout(this); session.setOrientation(LinearLayout.VERTICAL); session.setGravity(Gravity.CENTER_HORIZONTAL); TextView sv=label("—%",30,Color.WHITE,true); TextView sl=label("5시간",11,Color.rgb(150,150,150),false); session.addView(sv); session.addView(sl); metricBox.addView(session,new LinearLayout.LayoutParams(dp(72),-1));
        LinearLayout weekly=new LinearLayout(this); weekly.setOrientation(LinearLayout.VERTICAL); weekly.setGravity(Gravity.CENTER_HORIZONTAL); TextView wv=label("—%",30,Color.WHITE,true); TextView wl=label("주간",11,Color.rgb(150,150,150),false); weekly.addView(wv); weekly.addView(wl); metricBox.addView(weekly,new LinearLayout.LayoutParams(dp(72),-1));
        row.addView(metricBox,new LinearLayout.LayoutParams(-2,-1)); v.heroSessionValue=sv; v.heroWeeklyValue=wv; return row;
    }

    private View providerCard(String provider,String name,int accent) {
        ProviderViews v=viewsFor(provider);
        LinearLayout card=new LinearLayout(this); card.setOrientation(LinearLayout.VERTICAL); card.setPadding(dp(18),dp(17),dp(18),dp(17)); card.setBackgroundResource(R.drawable.bg_card);
        LinearLayout head=new LinearLayout(this); head.setGravity(Gravity.CENTER_VERTICAL); TextView n=label(name,19,Color.WHITE,true); head.addView(n,new LinearLayout.LayoutParams(0,-2,1)); v.status=label("확인 중…",13,accent,true); head.addView(v.status); card.addView(head);
        card.addView(metric("5시간 세션",true,v)); card.addView(metric("주간 한도",false,v)); v.updated=label("마지막 확인: -",12,Color.rgb(130,130,130),false); v.updated.setPadding(0,dp(10),0,0); card.addView(v.updated); return card;
    }

    private View metric(String name,boolean session,ProviderViews v) {
        LinearLayout box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(0,dp(17),0,0); LinearLayout line=new LinearLayout(this); line.setGravity(Gravity.CENTER_VERTICAL);
        TextView n=label(name,14,Color.rgb(215,215,215),false); line.addView(n,new LinearLayout.LayoutParams(0,-2,1)); TextView value=label("—%",34,Color.WHITE,true); line.addView(value); if(session)v.sessionValue=value;else v.weeklyValue=value;box.addView(line);
        ProgressBar bar=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);bar.setMax(100);bar.setProgressDrawable(getDrawable(R.drawable.progress_track));box.addView(bar,new LinearLayout.LayoutParams(-1,dp(8))); TextView reset=label("초기화: -",12,Color.rgb(140,140,140),false);reset.setPadding(0,dp(6),0,0);box.addView(reset);if(session){v.sessionBar=bar;v.sessionReset=reset;}else{v.weeklyBar=bar;v.weeklyReset=reset;}return box;
    }

    private View settingsRow() {
        LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(4),dp(12),dp(4),0); TextView head=label("상단바 표시 설정",15,Color.rgb(215,215,215),true);box.addView(head);box.addView(label("두 서비스를 모두 켜면 알림창과 최상단 상태바에 각각 표시됩니다. C 옆 위/아래 숫자는 5시간/주간입니다.",12,Color.rgb(160,160,160),false));
        box.addView(toggle("상태바에 Claude 표시 · 주황 C",UsageService.CLAUDE));box.addView(toggle("상태바에 Codex 표시 · 파랑 C",UsageService.CODEX)); return box;
    }
    private View toggle(String label,String provider) { LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);TextView t=label(label,13,Color.rgb(180,180,180),false);row.addView(t,new LinearLayout.LayoutParams(0,dp(45),1));Switch s=new Switch(this);s.setChecked(prefs.getBoolean("show_"+provider,true));s.setContentDescription(label+" 표시");s.setOnCheckedChangeListener((b,checked)->{prefs.edit().putBoolean("show_"+provider,checked).apply();if(prefs.getBoolean("status_icon_enabled",true)&&anyProviderEnabled())startUsageService(true);else if(!anyProviderEnabled())stopService(new Intent(this,UsageService.class));});row.addView(s);return row; }

    private void renderProvider(String provider,JSONObject o) { ProviderViews v=UsageService.CLAUDE.equals(provider)?claudeViews:codexViews;if(v==null)return;boolean login=o.optBoolean("needsLogin"),ok=o.optBoolean("ok");v.status.setText(login?"로그인 필요":ok?"정상적으로 확인됨":"확인 중…");v.status.setTextColor(login?Color.rgb(255,185,75):ok?Color.rgb(120,215,160):Color.rgb(217,119,87));JSONObject session=o.optJSONObject("session"),weekly=o.optJSONObject("weekly");apply(session,v.sessionValue,v.sessionBar,v.sessionReset);apply(weekly,v.weeklyValue,v.weeklyBar,v.weeklyReset);if(v.heroSessionValue!=null)v.heroSessionValue.setText(percentText(session));if(v.heroWeeklyValue!=null)v.heroWeeklyValue.setText(percentText(weekly));long at=prefs.getLong("updated_"+provider,0);v.updated.setText(at==0?"마지막 확인: -":"마지막 확인: "+android.text.format.DateFormat.format("M/d HH:mm",at));}
    private String percentText(JSONObject x){if(x==null||!x.has("pct"))return "—%";return String.format(Locale.US,"%d%%",Math.max(0,Math.min(100,(int)Math.round(x.optDouble("pct")))));}
    private void apply(JSONObject x,TextView value,ProgressBar bar,TextView reset){if(x==null||!x.has("pct")){value.setText("—%");bar.setProgress(0);reset.setText("초기화: -");return;}int p=Math.max(0,Math.min(100,(int)Math.round(x.optDouble("pct"))));value.setText(String.format(Locale.US,"%d%%",p));bar.setProgress(p);reset.setText("초기화: "+x.optString("reset","-"));}
    private void openLogin(String provider){Intent i=new Intent(this,LoginActivity.class);i.putExtra(UsageService.EXTRA_PROVIDER,provider);startActivity(i);}
    private boolean anyProviderEnabled(){return prefs.getBoolean("show_claude",true)||prefs.getBoolean("show_codex",true);}
    private void startUsageService(boolean refresh){if(!anyProviderEnabled())return;Intent i=new Intent(this,UsageService.class);if(refresh)i.setAction(UsageService.ACTION_REFRESH);if(Build.VERSION.SDK_INT>=26)startForegroundService(i);else startService(i);}
    private TextView label(String s,int size,int color,boolean bold){TextView v=new TextView(this);v.setText(s);v.setTextSize(size);v.setTextColor(color);v.setTypeface(Typeface.DEFAULT,bold?Typeface.BOLD:Typeface.NORMAL);return v;}
    private Button button(String s,boolean primary){Button b=new Button(this);b.setText(s);b.setTextColor(Color.WHITE);b.setTextSize(14);b.setAllCaps(false);b.setMinHeight(dp(50));b.setBackgroundResource(primary?R.drawable.bg_button:R.drawable.bg_secondary_button);return b;}
    private LinearLayout.LayoutParams fullParams(int top){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(52));p.setMargins(0,dp(top),0,0);return p;}
    private LinearLayout.LayoutParams cardParams(int top,int bottom){LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.setMargins(0,dp(top),0,dp(bottom));return p;}
    private int dp(int n){return(int)(n*getResources().getDisplayMetrics().density+0.5f);}
    @Override protected void onDestroy(){if(receiver!=null)unregisterReceiver(receiver);super.onDestroy();}
    private ProviderViews viewsFor(String provider){if(UsageService.CLAUDE.equals(provider)){if(claudeViews==null)claudeViews=new ProviderViews();return claudeViews;}if(codexViews==null)codexViews=new ProviderViews();return codexViews;}
    private static class ProviderViews{TextView status,updated,sessionValue,weeklyValue,sessionReset,weeklyReset,heroSessionValue,heroWeeklyValue;ProgressBar sessionBar,weeklyBar;}
}
