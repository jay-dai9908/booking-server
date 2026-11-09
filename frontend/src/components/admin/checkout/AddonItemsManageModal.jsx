import React, { useState, useEffect } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown, Check, X } from 'lucide-react';
import ResponsivePanel from '../ResponsivePanel';
import Button from '../../customer/Button';
import api from '../../../api/axios';

export default function AddonItemsManageModal({
  isOpen = false,
  onClose,
  onUpdated
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // New item form state
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState(30);
  const [newCategory, setNewCategory] = useState('charm');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Edit item state
  const [editingId, setEditingId] = useState(null);
  const [editPrice, setEditPrice] = useState('');
  const [editName, setEditName] = useState('');

  const fetchItems = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get('/checkout/addons');
      setItems(res.data || []);
    } catch (err) {
      console.error('[AddonItemsManageModal] Fetch error:', err);
      setError('無法載入加購品項');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchItems();
    }
  }, [isOpen]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;

    try {
      setIsSubmitting(true);
      setError(null);
      await api.post('/checkout/addons', {
        name: newName.trim(),
        price: parseInt(newPrice, 10) || 0,
        category: newCategory,
        sort_order: items.length + 1,
        is_active: true
      });
      setNewName('');
      setNewPrice(30);
      await fetchItems();
      if (onUpdated) onUpdated();
    } catch (err) {
      setError(err.response?.data?.error || '新增加購品項失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleActive = async (item) => {
    try {
      await api.put(`/checkout/addons/${item.id}`, {
        is_active: !item.is_active
      });
      await fetchItems();
      if (onUpdated) onUpdated();
    } catch (err) {
      setError(err.response?.data?.error || '更新失敗');
    }
  };

  const handleSaveEdit = async (id) => {
    try {
      await api.put(`/checkout/addons/${id}`, {
        name: editName.trim(),
        price: parseInt(editPrice, 10) || 0
      });
      setEditingId(null);
      await fetchItems();
      if (onUpdated) onUpdated();
    } catch (err) {
      setError(err.response?.data?.error || '儲存修改失敗');
    }
  };

  const handleMoveOrder = async (item, direction) => {
    const idx = items.findIndex(i => i.id === item.id);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= items.length) return;

    const targetItem = items[targetIdx];
    try {
      // Swap sort_order
      await Promise.all([
        api.put(`/checkout/addons/${item.id}`, { sort_order: targetItem.sort_order || targetIdx + 1 }),
        api.put(`/checkout/addons/${targetItem.id}`, { sort_order: item.sort_order || idx + 1 })
      ]);
      await fetchItems();
      if (onUpdated) onUpdated();
    } catch (err) {
      setError('調整順序失敗');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('確定要刪除此加購品項？')) return;
    try {
      await api.delete(`/checkout/addons/${id}`);
      await fetchItems();
      if (onUpdated) onUpdated();
    } catch (err) {
      setError(err.response?.data?.error || '刪除失敗');
    }
  };

  return (
    <ResponsivePanel
      isOpen={isOpen}
      onClose={onClose}
      title="管理加購品項"
      subtitle="常用吊飾、周邊與代燙加購快捷按鈕"
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" size="md" onClick={onClose}>
            完成
          </Button>
        </div>
      }
    >
      <div className="space-y-4 py-2">
        {error && (
          <div className="p-2.5 rounded-xl bg-sg-danger-soft text-sg-danger text-[12px] font-bold">
            {error}
          </div>
        )}

        {/* Create Form */}
        <form onSubmit={handleCreate} className="p-3.5 rounded-2xl bg-sg-paper/60 border border-sg-line space-y-2.5">
          <span className="text-[12px] font-bold text-sg-ink block">＋ 新增加購品項</span>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              required
              placeholder="品項名稱 (例如：夜光吊飾扣)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="flex-1 min-w-[140px] px-3 py-1.5 rounded-xl border border-sg-line text-[13px]"
            />
            <div className="relative w-24">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sg-muted text-[12px]">$</span>
              <input
                type="number"
                required
                min="0"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                className="w-full pl-6 pr-2 py-1.5 rounded-xl border border-sg-line text-[13px] font-bold"
              />
            </div>
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="px-2.5 py-1.5 rounded-xl border border-sg-line text-[12px] bg-white text-sg-ink"
            >
              <option value="charm">吊飾配件</option>
              <option value="service">代燙服務</option>
              <option value="craft">材料工具</option>
              <option value="other">其他周邊</option>
            </select>
            <Button variant="primary" size="sm" type="submit" loading={isSubmitting}>
              新增
            </Button>
          </div>
        </form>

        {/* Existing Items List */}
        <div className="space-y-2">
          <span className="text-[12px] font-bold text-sg-muted uppercase tracking-wider block">
            現有品項清單 ({items.length})
          </span>

          {loading ? (
            <div className="p-4 text-center text-sg-muted text-[12px]">載入中...</div>
          ) : items.length === 0 ? (
            <div className="p-4 text-center text-sg-muted text-[12px]">目前尚無任何加購品項</div>
          ) : (
            items.map((item, idx) => {
              const isEditing = editingId === item.id;

              return (
                <div
                  key={item.id}
                  className={`p-3 rounded-2xl border transition flex items-center justify-between gap-2 ${
                    item.is_active
                      ? 'bg-white border-sg-line'
                      : 'bg-sg-paper/40 border-dashed border-sg-line opacity-60'
                  }`}
                >
                  {isEditing ? (
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="flex-1 px-2.5 py-1 rounded-lg border border-sg-line text-[12px]"
                      />
                      <input
                        type="number"
                        value={editPrice}
                        onChange={(e) => setEditPrice(e.target.value)}
                        className="w-20 px-2 py-1 rounded-lg border border-sg-line text-[12px] font-bold"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveEdit(item.id)}
                        className="p-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
                        title="儲存"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="p-1.5 rounded-lg bg-sg-paper text-sg-muted hover:text-sg-ink"
                        title="取消"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 min-w-0">
                        {/* Sort up / down */}
                        <div className="flex flex-col gap-0.5">
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => handleMoveOrder(item, 'up')}
                            className="p-0.5 rounded text-sg-muted hover:text-sg-ink disabled:opacity-20"
                            title="上移"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === items.length - 1}
                            onClick={() => handleMoveOrder(item, 'down')}
                            className="p-0.5 rounded text-sg-muted hover:text-sg-ink disabled:opacity-20"
                            title="下移"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                        </div>

                        <div>
                          <span className="font-bold text-[13px] text-sg-ink block truncate">
                            {item.name}
                          </span>
                          <span className="text-[12px] font-num text-sg-brown font-bold">
                            NT${item.price}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(item.id);
                            setEditName(item.name);
                            setEditPrice(item.price);
                          }}
                          className="px-2 py-1 rounded-lg text-[11px] font-bold border border-sg-line bg-white hover:bg-sg-paper text-sg-ink"
                        >
                          改價
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(item)}
                          className={`px-2 py-1 rounded-lg text-[11px] font-bold border ${
                            item.is_active
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                              : 'bg-sg-paper text-sg-muted border-sg-line'
                          }`}
                        >
                          {item.is_active ? '啟用中' : '已停用'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(item.id)}
                          className="p-1 rounded-lg text-sg-muted hover:text-sg-danger hover:bg-sg-danger-soft transition"
                          title="刪除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </ResponsivePanel>
  );
}
