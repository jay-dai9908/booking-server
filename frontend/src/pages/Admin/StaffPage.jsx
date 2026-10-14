import React, { useState, useEffect } from 'react';
import { 
  ShieldCheck, 
  UserPlus, 
  KeyRound, 
  CalendarRange, 
  Users, 
  UserCog, 
  CalendarDays, 
  Grid, 
  Banknote, 
  Trash2, 
  Edit3, 
  Check, 
  Eye, 
  EyeOff, 
  X,
  AlertCircle
} from 'lucide-react';
import api from '../../api/axios';

const AVAILABLE_PERMISSIONS = [
  { 
    id: 'sessions', 
    label: '營業時段設定', 
    desc: '設定開放預約的日期、時段人數與價格', 
    icon: CalendarRange,
    color: 'text-amber-700 bg-amber-50 border-amber-200' 
  },
  { 
    id: 'reservations', 
    label: '預約訂單總覽', 
    desc: '查詢顧客訂單、出席狀態、備註與取消預約', 
    icon: Users,
    color: 'text-blue-700 bg-blue-50 border-blue-200' 
  },
  { 
    id: 'members', 
    label: '會員管理', 
    desc: '查看顧客名冊、歷史預約次數與黑名單', 
    icon: UserCog,
    color: 'text-emerald-700 bg-emerald-50 border-emerald-200' 
  },
  { 
    id: 'weekly', 
    label: '周營業狀況', 
    desc: '檢視每週預約總量與時段熱門分佈', 
    icon: CalendarDays,
    color: 'text-purple-700 bg-purple-50 border-purple-200' 
  },
  { 
    id: 'seating', 
    label: '帶位圖管理', 
    desc: '現場桌位視覺化排位與拖曳調位', 
    icon: Grid,
    color: 'text-orange-700 bg-orange-50 border-orange-200' 
  },
  { 
    id: 'accounting', 
    label: '帳務管理', 
    desc: '營業額報表、收款明細與未付款追蹤', 
    icon: Banknote,
    color: 'text-rose-700 bg-rose-50 border-rose-200' 
  },
];

export default function StaffPage() {
  const [staffs, setStaffs] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState(null);

  // Form states
  const [formData, setFormData] = useState({
    name: '',
    password: '',
    permissions: [],
    is_active: true
  });
  const [showPassword, setShowPassword] = useState({});
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    fetchStaffs();
  }, []);

  const fetchStaffs = async () => {
    setIsLoading(true);
    try {
      const res = await api.get('/staff');
      setStaffs(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenCreateModal = () => {
    setEditingStaff(null);
    setFormData({
      name: '',
      password: '',
      permissions: ['reservations', 'seating'], // default recommended for staff
      is_active: true
    });
    setFormError('');
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (staff) => {
    setEditingStaff(staff);
    setFormData({
      name: staff.name,
      password: staff.password,
      permissions: staff.permissions || [],
      is_active: staff.is_active
    });
    setFormError('');
    setIsModalOpen(true);
  };

  const handleTogglePermission = (permId) => {
    setFormData(prev => {
      const exists = prev.permissions.includes(permId);
      return {
        ...prev,
        permissions: exists 
          ? prev.permissions.filter(p => p !== permId)
          : [...prev.permissions, permId]
      };
    });
  };

  const handleSelectAllPermissions = () => {
    if (formData.permissions.length === AVAILABLE_PERMISSIONS.length) {
      setFormData(prev => ({ ...prev, permissions: [] }));
    } else {
      setFormData(prev => ({ ...prev, permissions: AVAILABLE_PERMISSIONS.map(p => p.id) }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');

    if (!formData.name.trim()) {
      setFormError('請輸入員工姓名');
      return;
    }
    if (!formData.password.trim()) {
      setFormError('請設定專屬密碼');
      return;
    }

    setIsSubmitting(true);
    try {
      if (editingStaff) {
        await api.put(`/staff/${editingStaff.id}`, formData);
      } else {
        await api.post('/staff', formData);
      }
      setIsModalOpen(false);
      fetchStaffs();
    } catch (err) {
      setFormError(err.response?.data?.error || '儲存失敗，請檢查輸入內容');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleActive = async (staff) => {
    try {
      await api.put(`/staff/${staff.id}`, {
        is_active: !staff.is_active
      });
      fetchStaffs();
    } catch (err) {
      alert(err.response?.data?.error || '更新狀態失敗');
    }
  };

  const handleDelete = async (staff) => {
    if (window.confirm(`確定要刪除工作人員「${staff.name}」嗎？此操作無法復原。`)) {
      try {
        await api.delete(`/staff/${staff.id}`);
        fetchStaffs();
      } catch (err) {
        alert(err.response?.data?.error || '刪除失敗');
      }
    }
  };

  const toggleShowPassword = (id) => {
    setShowPassword(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="p-4 md:p-8 space-y-8 animate-fade-in max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2.5">
            <ShieldCheck className="w-7 h-7 text-[#8B5B43]" />
            人員權限管理
          </h1>
          <p className="text-gray-500 mt-1 text-sm">
            為每位員工設定專屬密碼，並個別指派能訪問與操作的後台頁面。
          </p>
        </div>
        <button
          onClick={handleOpenCreateModal}
          className="inline-flex items-center justify-center gap-2 bg-[#8B5B43] hover:bg-[#724833] text-white px-5 py-2.5 rounded-xl text-sm font-semibold shadow-sm transition-all hover:shadow hover:scale-[1.01] active:scale-[0.99]"
        >
          <UserPlus className="w-4 h-4" />
          新增工作人員
        </button>
      </div>

      {/* Super Admin Notice Card */}
      <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-4 sm:p-5 flex items-start gap-3.5 shadow-sm">
        <div className="p-2 bg-[#8B5B43]/10 text-[#8B5B43] rounded-xl shrink-0 mt-0.5">
          <KeyRound className="w-5 h-5" />
        </div>
        <div className="text-sm space-y-1">
          <p className="font-semibold text-gray-900">
            最高管理員（店長）免帳號快速登入
          </p>
          <p className="text-gray-600 leading-relaxed">
            系統保留最高管理員密碼，登入後自動享有全部分頁權限與人員管理能力。在此新增的一般人員，輸入其專屬密碼登入後，系統將自動隱藏未被授權的分頁。
          </p>
        </div>
      </div>

      {/* Staff List Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="p-16 flex justify-center">
              <div className="w-8 h-8 border-4 border-gray-200 border-t-[#8B5B43] rounded-full animate-spin" />
            </div>
          ) : staffs.length === 0 ? (
            <div className="p-16 text-center text-gray-400 space-y-3">
              <UserCog className="w-12 h-12 mx-auto text-gray-300 stroke-[1.5]" />
              <p className="text-base font-medium text-gray-600">目前尚無其他工作人員</p>
              <p className="text-sm text-gray-400">點擊右上角「新增工作人員」即可建立專屬密碼與權限</p>
            </div>
          ) : (
            <table className="w-full text-left whitespace-nowrap">
              <thead>
                <tr className="bg-gray-50/80 text-gray-500 text-xs font-semibold uppercase tracking-wider border-b border-gray-200">
                  <th className="px-6 py-4">人員姓名</th>
                  <th className="px-6 py-4">專屬登入密碼</th>
                  <th className="px-6 py-4">可訪問的頁面權限</th>
                  <th className="px-6 py-4 text-center">帳號狀態</th>
                  <th className="px-6 py-4 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-sm">
                {staffs.map((staff) => {
                  const isVisible = showPassword[staff.id];
                  return (
                    <tr key={staff.id} className="hover:bg-amber-50/20 transition-colors">
                      {/* Name */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-[#FAF7F2] border border-[#E8DEC8] text-[#8B5B43] font-bold flex items-center justify-center shrink-0">
                            {staff.name.charAt(0)}
                          </div>
                          <div>
                            <div className="font-semibold text-gray-900">{staff.name}</div>
                            <div className="text-xs text-gray-400">ID: #{staff.id}</div>
                          </div>
                        </div>
                      </td>

                      {/* Password */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <code className="bg-gray-100 text-gray-800 px-2.5 py-1 rounded-lg font-mono text-sm tracking-wider">
                            {isVisible ? staff.password : '••••••'}
                          </code>
                          <button
                            type="button"
                            onClick={() => toggleShowPassword(staff.id)}
                            className="p-1 text-gray-400 hover:text-gray-700 rounded-md transition-colors"
                            title={isVisible ? '隱藏密碼' : '顯示密碼'}
                          >
                            {isVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </td>

                      {/* Permissions Badges */}
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-1.5 max-w-md">
                          {staff.permissions && staff.permissions.length > 0 ? (
                            staff.permissions.map(permId => {
                              const meta = AVAILABLE_PERMISSIONS.find(p => p.id === permId);
                              if (!meta) return null;
                              return (
                                <span
                                  key={permId}
                                  className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium border ${meta.color}`}
                                >
                                  {meta.label}
                                </span>
                              );
                            })
                          ) : (
                            <span className="text-xs text-gray-400 italic">無任何頁面權限</span>
                          )}
                        </div>
                      </td>

                      {/* Active Switch */}
                      <td className="px-6 py-4 text-center">
                        <button
                          type="button"
                          onClick={() => handleToggleActive(staff)}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                            staff.is_active ? 'bg-emerald-600' : 'bg-gray-300'
                          }`}
                          title={staff.is_active ? '點擊停用此人員' : '點擊啟用此人員'}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              staff.is_active ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>
                        <div className="text-[11px] font-medium mt-0.5 text-gray-500">
                          {staff.is_active ? '啟用中' : '已停用'}
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleOpenEditModal(staff)}
                            className="p-2 text-gray-400 hover:text-[#8B5B43] hover:bg-[#8B5B43]/10 rounded-lg transition-colors"
                            title="編輯人員與權限"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(staff)}
                            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="刪除人員"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Create / Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl shadow-xl border border-gray-100 w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-[#8B5B43]" />
                {editingStaff ? '編輯工作人員' : '新增工作人員'}
              </h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto">
              {formError && (
                <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              {/* Name */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                  員工姓名 / 稱呼 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="例如：小雅、晚班工讀"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#8B5B43] focus:bg-white focus:outline-none transition-all text-sm"
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                  專屬登入密碼 <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="設定一組專屬密碼 (不可與其他人重複)"
                  value={formData.password}
                  onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#8B5B43] focus:bg-white focus:outline-none transition-all text-sm font-mono tracking-wider"
                />
                <p className="text-xs text-gray-400 mt-1">
                  該員工在登入頁面直接輸入此密碼即可登入。
                </p>
              </div>

              {/* Permissions Checkbox Group */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-semibold text-gray-700">
                    可訪問的頁面權限 ({formData.permissions.length}/{AVAILABLE_PERMISSIONS.length})
                  </label>
                  <button
                    type="button"
                    onClick={handleSelectAllPermissions}
                    className="text-xs text-[#8B5B43] hover:underline font-medium"
                  >
                    {formData.permissions.length === AVAILABLE_PERMISSIONS.length ? '取消全選' : '全部選取'}
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-2.5">
                  {AVAILABLE_PERMISSIONS.map((perm) => {
                    const isChecked = formData.permissions.includes(perm.id);
                    const Icon = perm.icon;
                    return (
                      <div
                        key={perm.id}
                        onClick={() => handleTogglePermission(perm.id)}
                        className={`p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-3 ${
                          isChecked
                            ? 'bg-[#FAF7F2] border-[#8B5B43] ring-1 ring-[#8B5B43]/30'
                            : 'bg-white border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className={`w-5 h-5 mt-0.5 rounded flex items-center justify-center shrink-0 transition-colors ${
                          isChecked ? 'bg-[#8B5B43] text-white' : 'border border-gray-300 bg-white'
                        }`}>
                          {isChecked && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 font-semibold text-sm text-gray-900">
                            <Icon className="w-4 h-4 text-gray-500" />
                            {perm.label}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">{perm.desc}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Modal Footer */}
              <div className="pt-4 border-t border-gray-100 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2.5 border border-gray-200 text-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-6 py-2.5 bg-[#8B5B43] hover:bg-[#724833] text-white rounded-xl text-sm font-semibold shadow-sm transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {isSubmitting ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : null}
                  {editingStaff ? '儲存變更' : '確認新增'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
