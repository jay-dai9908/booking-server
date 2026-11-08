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
  const { status: printerStatus, refresh: refreshPrinterStatus } = usePrinterStatus(5000);
  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [stationList, setStationList] = useState([]);
  const [isPairing, setIsPairing] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);

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

  // Test Print
  const handleTestPrint = async () => {
    try {
      const defaultStation = stationList.find(s => s.is_default) || stationList[0];
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
  const succeededCount = jobs.filter(j => j.status === 'succeeded').length;
  const pendingCount = jobs.filter(j => j.status === 'pending' || j.status === 'claimed').length;
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
            <p className="text-[13px] font-bold text-sg-ink">商米 POS 櫃檯收據與票券印表機</p>
          </div>
        </div>

        <div>
          <span className={`px-3 py-1 rounded-full text-[12px] font-bold ${
            printerStatus?.online
              ? 'bg-sg-sage-soft text-sg-sage-ink'
              : 'bg-sg-danger-soft text-sg-danger'
          }`}>
            {printerStatus?.online ? '在線' : '離線'}
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
              {printerStatus?.label || '正常 · 紙張充足'}
            </span>
          </div>

          <div className="p-3 rounded-2xl bg-sg-paper/40 border border-sg-line">
            <span className="text-sg-muted text-[11px] block">背景接單服務</span>
            <span className="font-bold text-sg-ink">
              {isSunmiApp ? '執行中（螢幕可關閉）' : '一般瀏覽器模式'}
            </span>
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center justify-between pt-2 border-t border-sg-line text-[13px]">
          <span className="text-sg-muted">今日統計</span>
          <div className="flex items-center gap-3">
            <span className="text-sg-ink">已印 <strong className="font-num">{succeededCount}</strong></span>
            <span className="text-sg-brown">等待 <strong className="font-num">{pendingCount}</strong></span>
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
              const isSuccess = job.status === 'succeeded';
              const timeStr = new Date(job.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' });

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
                        'bg-sg-paper text-sg-muted'
                      }`}>
                        {isSuccess ? '已印出' : isFailed ? '失敗' : '排隊中'}
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
                          重印
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleCancelJob(job.id)}
                        >
                          取消
                        </Button>
                      </>
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
        <Button
          variant="secondary"
          size="md"
          onClick={handleTestPrint}
          className="w-full sm:w-auto whitespace-nowrap"
        >
          測試列印
        </Button>

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
