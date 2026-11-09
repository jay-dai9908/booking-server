import React, { useState, useEffect } from 'react';
import {
  Printer,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Play,
  Pause,
  X,
  ExternalLink,
  Smartphone,
  Layers,
  HelpCircle
} from 'lucide-react';
import api from '../../api/axios';
import { usePrinterStatus } from '../../hooks/admin/usePrinterStatus';
import StatusPill from '../../components/admin/StatusPill';
import Button from '../../components/customer/Button';
import { printJobOnThisDevice } from '../../utils/sunmiPrinter';

export default function PrintStationPage() {
  const { station, refresh: refreshPrinterStatus } = usePrinterStatus(5000);
  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [stationList, setStationList] = useState([]);
  const [isPairing, setIsPairing] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  const [isTogglingAccept, setIsTogglingAccept] = useState(false);

  // Check if running inside Sunmi Android App WebView
  const isSunmiApp = typeof window !== 'undefined' && Boolean(window.AndroidPrinter?.getStationStatus);

  const fetchJobs = async () => {
    try {
      setLoadingJobs(true);
      const res = await api.get('/print/jobs');
      setJobs(res.data?.jobs || []);
    } catch (err) {
      console.error('[PrintStation] Failed to fetch jobs:', err);
    } finally {
      setLoadingJobs(false);
    }
  };

  const fetchStations = async () => {
    try {
      const res = await api.get('/print/stations');
      setStationList(res.data?.stations || []);
    } catch (err) {
      console.warn('[PrintStation] Failed to fetch stations:', err);
    }
  };

  useEffect(() => {
    fetchJobs();
    fetchStations();
    const interval = setInterval(fetchJobs, 6000);
    return () => clearInterval(interval);
  }, []);

  const showToast = (msg) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(null), 3000);
  };

  const isOnline = Boolean(station?.online);
  const isAccepting = station ? station.accepting !== false : true;

  const lastSeenFull = station?.last_seen_at
    ? new Date(station.last_seen_at).toLocaleTimeString('zh-TW', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Taipei'
      })
    : null;

  const lastSeenShort = station?.last_seen_at
    ? new Date(station.last_seen_at).toLocaleTimeString('zh-TW', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Taipei'
      })
    : null;

  const getPrinterStateLabel = () => {
    if (!isOnline) {
      return lastSeenShort ? `無法取得（最後回報 ${lastSeenShort}）` : '無法取得（離線）';
    }
    if (station?.state === 'no_paper') return '缺紙';
    if (station?.state === 'cover_open') return '上蓋開啟';
    if (station?.state === 'overheat') return '過熱';
    if (station?.state === 'error') return station.message || '印表機異常';
    return station?.message || '正常 · 紙張充足';
  };

  // Test Print
  const handleTestPrint = async () => {
    try {
      const defaultStation = station || stationList.find(s => s.is_default) || stationList[0];
      const res = defaultStation
        ? await api.post(`/print/stations/${defaultStation.id}/test`)
        : await api.post('/print/jobs', { type: 'test', title: '印表機測試頁' });
      showToast('已送出測試列印工作！');
      fetchJobs();
      if (isSunmiApp && res.data?.job) {
        await printJobOnThisDevice(res.data.job);
      }
    } catch (err) {
      showToast(err.response?.data?.error || '測試列印失敗');
    }
  };

  // Toggle accepting orders
  const handleToggleAccepting = async () => {
    const targetStation = station || stationList.find(s => s.is_default) || stationList[0];
    if (!targetStation?.id) {
      showToast('尚未配對列印站');
      return;
    }
    try {
      setIsTogglingAccept(true);
      await api.patch(`/print/stations/${targetStation.id}`, {
        accepting: !isAccepting
      });
      showToast(isAccepting ? '已暫停接單' : '已恢復接單');
      refreshPrinterStatus();
      fetchStations();
    } catch (err) {
      showToast(err.response?.data?.error || '變更接單狀態失敗');
    } finally {
      setIsTogglingAccept(false);
    }
  };

  // Retry failed job
  const handleRetryJob = async (jobId) => {
    try {
      await api.post(`/print/jobs/${jobId}/retry`);
      showToast('已重新將工作加入排隊');
      fetchJobs();
    } catch (err) {
      showToast(err.response?.data?.error || '重新列印失敗');
    }
  };

  // Cancel job
  const handleCancelJob = async (jobId) => {
    try {
      await api.post(`/print/jobs/${jobId}/cancel`);
      showToast('已取消此列印工作');
      fetchJobs();
    } catch (err) {
      showToast(err.response?.data?.error || '取消失敗');
    }
  };

  // Pair this Sunmi device
  const handlePairStation = async () => {
    try {
      setIsPairing(true);
      const res = await api.post('/print/stations/pair', {
        name: '櫃檯商米主機',
        is_default: true
      });

      if (window.AndroidPrinter?.saveStationCredentials) {
        window.AndroidPrinter.saveStationCredentials(JSON.stringify(res.data));
        showToast('配對成功！已啟動背景接單服務');
      } else {
        showToast('已產生配對憑證');
      }
      fetchStations();
      refreshPrinterStatus();
    } catch (err) {
      showToast(err.response?.data?.error || '配對列印站失敗');
    } finally {
      setIsPairing(false);
    }
  };

  // Stats calculation
  const printedCount = jobs.filter(j => j.status === 'succeeded' || j.status === 'printed').length;
  const waitingCount = jobs.filter(j => j.status === 'pending' || j.status === 'queued' || j.status === 'claimed').length;
  const failedCount = jobs.filter(j => j.status === 'failed').length;

  return (
    <div className="space-y-4 max-w-2xl mx-auto pb-16">
      {/* Toast */}
      {actionMsg && (
        <div className="fixed top-4 right-4 z-50 bg-sg-ink text-white px-4 py-2.5 rounded-2xl shadow-lg text-[13px] font-bold animate-fade-in">
          {actionMsg}
        </div>
      )}

      {/* Top Header */}
      <div className="bg-white p-4 rounded-3xl border border-sg-line shadow-xs flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-sg-paper border border-sg-line flex items-center justify-center text-sg-brown">
            <Printer className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[13px] font-bold text-sg-ink">
              {station?.name || '商米 POS 櫃檯收據與票券印表機'}
            </p>
            {lastSeenFull && (
              <p className="text-[11px] text-sg-muted">最後回報 {lastSeenFull}</p>
            )}
          </div>
        </div>

        <div>
          <span className={`px-3 py-1 rounded-full text-[12px] font-bold ${
            isOnline
              ? 'bg-sg-sage-soft text-sg-sage-ink'
              : 'bg-sg-danger-soft text-sg-danger'
          }`}>
            {isOnline ? '在線' : '離線'}
          </span>
        </div>
      </div>

      {/* Environment Banner */}
      {!isSunmiApp && (
        <div className="p-3.5 rounded-2xl bg-sg-paper/60 border border-sg-line text-[12px] text-sg-muted flex items-start gap-2.5">
          <Smartphone className="w-4 h-4 text-sg-brown flex-shrink-0 mt-0.5" />
          <span>
            這個頁面在一般瀏覽器只能看佇列；要自動接收結帳單列印，請在櫃檯商米的拾光 App 裡打開。
          </span>
        </div>
      )}

      {/* Status Details Card */}
      <div className="bg-white p-4 rounded-3xl border border-sg-line shadow-xs space-y-3">
        <div className="grid grid-cols-2 gap-3 text-[13px]">
          <div className="p-3 rounded-2xl bg-sg-paper/40 border border-sg-line">
            <span className="text-sg-muted text-[11px] block">印表機狀態</span>
            <span className="font-bold text-sg-ink">
              {getPrinterStateLabel()}
            </span>
          </div>

          <div className="p-3 rounded-2xl bg-sg-paper/40 border border-sg-line">
            <span className="text-sg-muted text-[11px] block">背景接單服務</span>
            <span className="font-bold text-sg-ink">
              {!isAccepting
                ? '已暫停接單'
                : isSunmiApp
                ? '執行中（螢幕可關閉）'
                : '接單中（一般瀏覽器）'}
            </span>
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center justify-between pt-2 border-t border-sg-line text-[13px]">
          <span className="text-sg-muted">今日統計</span>
          <div className="flex items-center gap-3">
            <span className="text-sg-ink">今日已印 <strong className="font-num">{printedCount}</strong> 張</span>
            <span className="text-sg-brown">等待 <strong className="font-num">{waitingCount}</strong></span>
            <span className="text-sg-danger">失敗 <strong className="font-num">{failedCount}</strong></span>
          </div>
        </div>
      </div>

      {/* Print Queue List */}
      <div className="bg-white p-4 rounded-3xl border border-sg-line shadow-xs space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-sg-line">
          <h2 className="text-[14px] font-bold text-sg-ink">列印佇列 (最近 30 筆)</h2>
          <button
            type="button"
            onClick={fetchJobs}
            className="text-[12px] text-sg-brown hover:underline font-bold"
          >
            重新整理
          </button>
        </div>

        {loadingJobs ? (
          <div className="py-8 text-center text-sg-muted text-[13px]">載入佇列中...</div>
        ) : jobs.length === 0 ? (
          <div className="py-8 text-center text-sg-muted text-[13px]">佇列中沒有待印工作</div>
        ) : (
          <div className="divide-y divide-sg-line">
            {jobs.map((job) => {
              const isFailed = job.status === 'failed';
              const isSuccess = job.status === 'succeeded' || job.status === 'printed';
              const timeStr = new Date(job.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' });
              const printedTime = new Date(job.printed_at || job.updated_at || job.created_at).toLocaleTimeString('zh-TW', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: 'Asia/Taipei'
              });

              return (
                <div key={job.id} className="py-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-[13px] text-sg-ink">
                        {job.title || `收據單 #${job.id}`}
                      </span>
                      <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                        isSuccess ? 'bg-sg-sage-soft text-sg-sage-ink' :
                        isFailed ? 'bg-sg-danger-soft text-sg-danger' :
                        job.status === 'claimed' ? 'bg-sg-honey-soft text-sg-honey-ink' :
                        'bg-sg-paper text-sg-muted'
                      }`}>
                        {isSuccess ? `已印 ${printedTime}` : isFailed ? '失敗' : job.status === 'claimed' ? '列印中' : '排隊中'}
                      </span>
                    </div>

                    <div className="text-[11px] text-sg-muted mt-0.5">
                      #P-{String(job.id).padStart(4, '0')} · {job.source_device || '門市端'} · {timeStr}
                      {job.error_message && (
                        <span className="text-sg-danger block mt-0.5 font-bold">原因：{job.error_message}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {isFailed ? (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => handleRetryJob(job.id)}
                        >
                          換好紙，重印
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleCancelJob(job.id)}
                        >
                          取消
                        </Button>
                      </>
                    ) : isSuccess ? (
                      <span className="text-[12px] text-sg-sage-ink font-bold">
                        已印 {printedTime}
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                          await printJobOnThisDevice(job);
                          showToast('已在本機印出');
                        }}
                      >
                        用這台印
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom Actions */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-2">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            onClick={handleTestPrint}
            className="w-full sm:w-auto whitespace-nowrap"
          >
            測試列印
          </Button>

          <Button
            variant={isAccepting ? "secondary" : "primary"}
            size="md"
            onClick={handleToggleAccepting}
            loading={isTogglingAccept}
            className="w-full sm:w-auto whitespace-nowrap"
          >
            {isAccepting ? '暫停接單' : '恢復接單'}
          </Button>
        </div>

        {isSunmiApp && (
          <Button
            variant="primary"
            size="md"
            onClick={handlePairStation}
            loading={isPairing}
            className="w-full sm:w-auto whitespace-nowrap"
          >
            把這台設為列印站
          </Button>
        )}
      </div>
    </div>
  );
}
