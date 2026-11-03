import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import CustomerLayout from '../../components/customer/CustomerLayout';
import AppBar from '../../components/customer/AppBar';
import StepSelectTime from './booking/StepSelectTime';
import StepPeopleAddons from './booking/StepPeopleAddons';
import StepConfirm from './booking/StepConfirm';
import StepDone from './booking/StepDone';
import { useToast } from '../../components/customer/Toast';
import { useGlobalSettings } from '../../hooks/customer/useGlobalSettings';
import { useSessions, useSessionRange, BOOKING_LOOKAHEAD_DAYS } from '../../hooks/customer/useSessions';
import { useDayPricing } from '../../hooks/customer/useDayPricing';
import { useCustomerProfile } from '../../hooks/customer/useCustomerProfile';
import api from '../../api/axios';
import { parseYMD } from '../../utils/customer/pricing';

const DRAFT_KEY = 'shiguang_booking_draft';

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getEndDateString(daysAhead) {
  const target = new Date();
  target.setDate(target.getDate() + daysAhead);
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, '0');
  const d = String(target.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function loadInitialDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.date) {
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

export default function Booking() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const step = searchParams.get('step') || '1';

  // Global settings & Customer profile
  const {
    settings: globalSettings,
    loading: globalLoading,
    error: globalError,
    reload: reloadGlobalSettings,
    hasPricing,
  } = useGlobalSettings();
  const { user } = useCustomerProfile();
  const userRole = user?.role || 'customer';

  // Range dates for DateStrip / Calendar
  const todayStr = useMemo(() => getTodayString(), []);
  const lookaheadEndStr = useMemo(() => getEndDateString(BOOKING_LOOKAHEAD_DAYS - 1), []);
  const { sessionsByDate } = useSessionRange(todayStr, lookaheadEndStr);

  // Draft state
  const initialDraft = useMemo(() => loadInitialDraft(), []);
  const [date, setDate] = useState(() => initialDraft?.date || todayStr);
  const [mode, setMode] = useState(() => initialDraft?.mode || 'timed');
  const [sel, setSel] = useState(() => initialDraft?.sel || null);
  const [arrival, setArrival] = useState(() => initialDraft?.arrival ?? null);
  const [leave, setLeave] = useState(() => initialDraft?.leave ?? null);
  const [pax, setPax] = useState(() => initialDraft?.pax || 1);
  const [units, setUnits] = useState(() => initialDraft?.units || []);
  const [customerNote, setCustomerNote] = useState(() => initialDraft?.customerNote || '');
  const [promo, setPromo] = useState(() => initialDraft?.promo || null);

  // Save draft whenever state changes
  useEffect(() => {
    if (step === 'done') return;
    try {
      const draftObj = {
        date,
        mode,
        sel,
        arrival,
        leave,
        pax,
        units,
        customerNote,
        promo,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draftObj));
    } catch (e) {}
  }, [step, date, mode, sel, arrival, leave, pax, units, customerNote, promo]);

  // Pricing for selected date
  const { dayPricing } = useDayPricing(date, globalSettings);

  // Sessions for selected date
  const {
    sessions,
    loading: sessionsLoading,
    updateText,
  } = useSessions(date, {
    autoRefresh: true,
    onUpdated: (newSessions) => {
      // Auto-adjust if selected slot became full or past
      if (sel) {
        const sorted = [...newSessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
        let adjusted = false;
        let newEnd = sel.end;
        for (let i = sel.start; i <= sel.end; i++) {
          const s = sorted[i];
          if (!s || s.remaining_capacity <= 0) {
            if (i === sel.start) {
              setSel(null);
              toast.show(`${s?.start_time || ''} 的時段剛剛額滿，已幫你調整選取`, { type: 'info' });
              return;
            } else {
              newEnd = i - 1;
              adjusted = true;
              break;
            }
          }
        }
        if (adjusted) {
          setSel({ start: sel.start, end: newEnd });
          toast.show('部分時段剛剛額滿，已幫你調整選取', { type: 'info' });
        }
      }
    },
  });

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
  }, [sessions]);

  // Compute selected booking sessions
  const bookingSessions = useMemo(() => {
    if (!sortedSessions.length) return [];
    if (mode === 'timed') {
      if (!sel) return [];
      return sortedSessions.slice(sel.start, sel.end + 1);
    } else {
      if (arrival == null || leave == null || leave <= arrival) return [];
      return sortedSessions.slice(arrival, leave);
    }
  }, [sortedSessions, mode, sel, arrival, leave]);

  // Equipment configs and live stock
  const [equipmentConfigs, setEquipmentConfigs] = useState([]);
  const [availBySession, setAvailBySession] = useState({});

  useEffect(() => {
    if (!date || !bookingSessions.length) return;
    const sessionStarts = bookingSessions.map((s) => s.start_time).join(',');
    api.get(`/equipment/availability?date=${date}&sessions=${sessionStarts}&per_session=1`)
      .then((res) => {
        const equipments = res.data?.equipments || [];
        setEquipmentConfigs(equipments);
        setAvailBySession(Object.fromEntries(equipments.map((e) => [e.id, e.available_by_session || {}])));
      })
      .catch((err) => {
        console.error('Failed to fetch equipment availability', err);
      });
  }, [date, bookingSessions]);

  // Validate step route
  useEffect(() => {
    if (step === 'done') {
      if (!location.state?.result) {
        navigate('/history?tab=bookings', { replace: true });
      }
      return;
    }

    if (step === '2' || step === '3') {
      // Must have selected sessions
      if (bookingSessions.length === 0) {
        navigate('/booking?step=1', { replace: true });
      }
    }
  }, [step, bookingSessions.length, location.state, navigate]);

  // Date change handler
  const handleDateChange = (newDate) => {
    setDate(newDate);
    // Reset timed selection
    setSel(null);
    setArrival(null);
    setLeave(null);
    setUnits([]);
  };

  // Completed booking
  const handleBookingSuccess = (result) => {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch (e) {}
    navigate('/booking?step=done', { replace: true, state: { result } });
  };

  // Header setup per step
  let headerSlot = null;
  if (step === '1') {
    headerSlot = (
      <AppBar
        variant="brand"
        title="預約時段"
        right={<span className="sg-small whitespace-nowrap">{updateText}</span>}
      />
    );
  } else if (step === '2') {
    headerSlot = (
      <AppBar
        variant="back"
        title="預約時段"
        onBack={() => navigate('/booking?step=1')}
      />
    );
  } else if (step === '3') {
    headerSlot = (
      <AppBar
        variant="back"
        title="確認預約"
        onBack={() => navigate('/booking?step=2')}
      />
    );
  }

  return (
    <CustomerLayout
      header={headerSlot}
      bare={step === 'done'}
    >
      {step === '1' && (
        <StepSelectTime
          date={date}
          onChangeDate={handleDateChange}
          mode={mode}
          onChangeMode={setMode}
          sel={sel}
          onChangeSel={setSel}
          arrival={arrival}
          onChangeArrival={setArrival}
          leave={leave}
          onChangeLeave={setLeave}
          pax={pax}
          globalSettings={globalSettings}
          dayPricing={dayPricing}
          hasPricing={hasPricing}
          globalLoading={globalLoading}
          globalError={globalError}
          onReloadPricing={reloadGlobalSettings}
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          sessionsByDate={sessionsByDate}
          equipmentConfigs={equipmentConfigs}
          onNext={() => navigate('/booking?step=2')}
          userRole={userRole}
        />
      )}

      {step === '2' && (
        <StepPeopleAddons
          date={date}
          mode={mode}
          bookingSessions={bookingSessions}
          pax={pax}
          onChangePax={setPax}
          units={units}
          onChangeUnits={setUnits}
          globalSettings={globalSettings}
          dayPricing={dayPricing}
          hasPricing={hasPricing}
          globalLoading={globalLoading}
          globalError={globalError}
          onReloadPricing={reloadGlobalSettings}
          equipmentConfigs={equipmentConfigs}
          availBySession={availBySession}
          onBack={() => navigate('/booking?step=1')}
          onNext={() => navigate('/booking?step=3')}
        />
      )}

      {step === '3' && (
        <StepConfirm
          date={date}
          mode={mode}
          bookingSessions={bookingSessions}
          pax={pax}
          units={units}
          customerNote={customerNote}
          onChangeNote={setCustomerNote}
          promo={promo}
          onChangePromo={setPromo}
          globalSettings={globalSettings}
          dayPricing={dayPricing}
          hasPricing={hasPricing}
          globalLoading={globalLoading}
          globalError={globalError}
          onReloadPricing={reloadGlobalSettings}
          equipmentConfigs={equipmentConfigs}
          onBack={() => navigate('/booking?step=2')}
          onBookingSuccess={handleBookingSuccess}
          onGoBackToSelectTime={() => navigate('/booking?step=1')}
        />
      )}

      {step === 'done' && (
        <StepDone result={location.state?.result} />
      )}
    </CustomerLayout>
  );
}
